import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import dayjs from "dayjs";
import type {
  CodexSession,
  CodexConversationSignal,
  CodexSessionInsight,
  EvalStandard,
} from "../types.js";
import { buildNoiseFilter } from "../utils.js";

const DEFAULT_CODEX_DIR = join(homedir(), ".codex");

function resolvePaths(codexDir: string) {
  return {
    stateDb: join(codexDir, "state_5.sqlite"),
    logsDb: join(codexDir, "logs_2.sqlite"),
    historyFile: join(codexDir, "history.jsonl"),
  };
}

export function extractSessions(
  since: string,
  until: string,
  codexDir: string = DEFAULT_CODEX_DIR,
): CodexSession[] {
  const { stateDb } = resolvePaths(codexDir);
  if (!existsSync(stateDb)) return [];

  const sinceEpoch = dayjs(since).startOf("day").unix();
  const untilEpoch = dayjs(until).endOf("day").unix();

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(stateDb, { readonly: true });
    const rows = db
      .prepare(
        `SELECT
           id, created_at, updated_at, model, model_provider,
           cwd, title, tokens_used, git_branch, git_origin_url,
           first_user_message, cli_version
         FROM threads
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC`,
      )
      .all(sinceEpoch, untilEpoch) as Array<{
      id: string;
      created_at: number;
      updated_at: number;
      model: string | null;
      model_provider: string;
      cwd: string;
      title: string;
      tokens_used: number;
      git_branch: string | null;
      git_origin_url: string | null;
      first_user_message: string;
      cli_version: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      model: r.model ?? "unknown",
      modelProvider: r.model_provider,
      cwd: r.cwd,
      title: r.title,
      tokensUsed: r.tokens_used,
      gitBranch: r.git_branch,
      gitOriginUrl: r.git_origin_url,
      firstUserMessage: r.first_user_message,
      cliVersion: r.cli_version,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function parseHistoryInsights(
  sessionIds: Set<string>,
  insights: Map<string, CodexSessionInsight>,
  historyFile: string,
): void {
  if (!existsSync(historyFile) || sessionIds.size === 0) return;

  try {
    const content = readFileSync(historyFile, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const sessionId =
        typeof parsed.session_id === "string" ? parsed.session_id : "";
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      const ts = typeof parsed.ts === "number" ? parsed.ts : 0;
      if (!sessionIds.has(sessionId) || !text) continue;

      const insight = insights.get(sessionId);
      if (!insight) continue;

      insight.userMessages.push({
        timestamp: ts > 0 ? dayjs.unix(ts).toISOString() : "",
        text,
      });
    }
  } catch {
    // ignore unreadable history file
  }
}

function parseLogInsights(
  sessionIds: Set<string>,
  insights: Map<string, CodexSessionInsight>,
  logsDb: string,
): void {
  if (!existsSync(logsDb) || sessionIds.size === 0) return;

  let db: InstanceType<typeof Database> | undefined;
  try {
    const ids = [...sessionIds];
    const placeholders = ids.map(() => "?").join(", ");
    db = new Database(logsDb, { readonly: true });
    const rows = db
      .prepare(
        `SELECT thread_id, level, feedback_log_body
         FROM logs
         WHERE thread_id IN (${placeholders})
           AND feedback_log_body IS NOT NULL`,
      )
      .all(...ids) as Array<{
      thread_id: string;
      level: string;
      feedback_log_body: string;
    }>;

    for (const row of rows) {
      const insight = insights.get(row.thread_id);
      if (!insight) continue;

      const toolCallMatch = row.feedback_log_body.match(
        /ToolCall:\s+([a-zA-Z0-9_]+)/,
      );
      if (toolCallMatch) {
        const toolName = toolCallMatch[1];
        insight.toolCallCount += 1;
        insight.toolCalls[toolName] = (insight.toolCalls[toolName] ?? 0) + 1;
      }

      if (row.level === "ERROR") {
        insight.errorCount += 1;
      }
    }
  } catch {
    // ignore unreadable log database
  } finally {
    db?.close();
  }
}

export function extractSessionInsights(
  sessions: CodexSession[],
  codexDir: string = DEFAULT_CODEX_DIR,
): Map<string, CodexSessionInsight> {
  const { historyFile, logsDb } = resolvePaths(codexDir);
  const insights = new Map<string, CodexSessionInsight>();

  for (const session of sessions) {
    insights.set(session.id, {
      sessionId: session.id,
      userMessages: [],
      toolCallCount: 0,
      toolCalls: {},
      errorCount: 0,
    });
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  parseHistoryInsights(sessionIds, insights, historyFile);
  parseLogInsights(sessionIds, insights, logsDb);

  return insights;
}

export function scanThreadSignals(
  sessions: CodexSession[],
  insights: Map<string, CodexSessionInsight>,
  standard: EvalStandard,
): CodexConversationSignal[] {
  const isNoise = buildNoiseFilter(standard);
  const sectionKeywords = standard.sections.map((sec) => ({
    sectionId: sec.id,
    keywords: sec.keywords,
  }));

  const signals: CodexConversationSignal[] = [];

  for (const session of sessions) {
    const insight = insights.get(session.id);
    const entries = [
      {
        timestamp: dayjs.unix(session.createdAt).toISOString(),
        text: session.title,
      },
      {
        timestamp: dayjs.unix(session.createdAt).toISOString(),
        text: session.firstUserMessage,
      },
      ...(insight?.userMessages ?? []),
    ];

    const seen = new Set<string>();
    for (const entry of entries) {
      const text = entry.text.trim();
      if (!text || isNoise(text) || seen.has(text)) continue;
      seen.add(text);

      const lowerText = text.toLowerCase();
      for (const { sectionId, keywords } of sectionKeywords) {
        const hits = keywords.filter((k) =>
          lowerText.includes(k.toLowerCase()),
        );
        if (hits.length === 0) continue;

        signals.push({
          sessionId: session.id,
          timestamp: entry.timestamp,
          type: sectionId,
          content: text.slice(0, 200),
          keywords: hits,
        });
      }
    }
  }

  return signals;
}
