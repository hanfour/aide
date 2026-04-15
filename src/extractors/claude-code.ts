import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import dayjs from "dayjs";
import type {
  ClaudeCodeSession,
  ClaudeCodeFacet,
  ClaudeCodeCostRecord,
  ClaudeCodeConversationSignal,
  EvalStandard,
} from "../types.js";
import { buildNoiseFilter } from "../utils.js";

const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude");

function resolvePaths(claudeDir: string) {
  return {
    sessionMetaDir: join(claudeDir, "usage-data", "session-meta"),
    facetsDir: join(claudeDir, "usage-data", "facets"),
    storeDb: join(claudeDir, "__store.db"),
    projectsDir: join(claudeDir, "projects"),
  };
}

// ── Session meta extraction ──

export function extractSessions(
  since: string,
  until: string,
  claudeDir: string = DEFAULT_CLAUDE_DIR,
): ClaudeCodeSession[] {
  const { sessionMetaDir } = resolvePaths(claudeDir);
  if (!existsSync(sessionMetaDir)) return [];

  const sinceDate = dayjs(since).startOf("day");
  const untilDate = dayjs(until).endOf("day");
  const sessions: ClaudeCodeSession[] = [];

  for (const file of readdirSync(sessionMetaDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(sessionMetaDir, file), "utf-8"));
      const startTime = dayjs(raw.start_time);
      if (startTime.isBefore(sinceDate) || startTime.isAfter(untilDate))
        continue;

      sessions.push({
        sessionId: raw.session_id,
        projectPath: raw.project_path ?? "",
        startTime: raw.start_time,
        durationMinutes: raw.duration_minutes ?? 0,
        userMessageCount: raw.user_message_count ?? 0,
        assistantMessageCount: raw.assistant_message_count ?? 0,
        toolCounts: raw.tool_counts ?? {},
        languages: raw.languages ?? {},
        gitCommits: raw.git_commits ?? 0,
        inputTokens: raw.input_tokens ?? 0,
        outputTokens: raw.output_tokens ?? 0,
        firstPrompt: raw.first_prompt ?? "",
        userInterruptions: raw.user_interruptions ?? 0,
        toolErrors: raw.tool_errors ?? 0,
        toolErrorCategories: raw.tool_error_categories ?? {},
        usesTaskAgent: raw.uses_task_agent ?? false,
        usesMcp: raw.uses_mcp ?? false,
        linesAdded: raw.lines_added ?? 0,
        linesRemoved: raw.lines_removed ?? 0,
        filesModified: raw.files_modified ?? 0,
        messageHours: raw.message_hours ?? [],
      });
    } catch {
      // skip malformed files
    }
  }

  return sessions;
}

// ── Facets extraction ──

export function extractFacets(
  sessionIds: Set<string>,
  claudeDir: string = DEFAULT_CLAUDE_DIR,
): Map<string, ClaudeCodeFacet> {
  const { facetsDir } = resolvePaths(claudeDir);
  if (!existsSync(facetsDir)) return new Map();

  const facets = new Map<string, ClaudeCodeFacet>();

  for (const file of readdirSync(facetsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(facetsDir, file), "utf-8"));
      const sid = raw.session_id ?? file.replace(".json", "");
      if (!sessionIds.has(sid)) continue;

      facets.set(sid, {
        sessionId: sid,
        underlyingGoal: raw.underlying_goal ?? "",
        goalCategories: raw.goal_categories ?? {},
        outcome: raw.outcome ?? "",
        userSatisfactionCounts: raw.user_satisfaction_counts ?? {},
        claudeHelpfulness: raw.claude_helpfulness ?? "",
        sessionType: raw.session_type ?? "",
        frictionCounts: raw.friction_counts ?? {},
        frictionDetail: raw.friction_detail ?? "",
        primarySuccess: raw.primary_success ?? "",
        briefSummary: raw.brief_summary ?? "",
      });
    } catch {
      // skip malformed files
    }
  }

  return facets;
}

// ── Cost extraction from SQLite ──

export function extractCosts(
  since: string,
  until: string,
  claudeDir: string = DEFAULT_CLAUDE_DIR,
): ClaudeCodeCostRecord[] {
  const { storeDb } = resolvePaths(claudeDir);
  if (!existsSync(storeDb)) return [];

  const sinceEpoch = dayjs(since).startOf("day").unix();
  const untilEpoch = dayjs(until).endOf("day").unix();

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(storeDb, { readonly: true });
    const rows = db
      .prepare(
        `SELECT
           bm.session_id,
           am.model,
           SUM(am.cost_usd) as total_cost,
           SUM(am.duration_ms) as total_duration,
           COUNT(*) as msg_count
         FROM assistant_messages am
         JOIN base_messages bm ON am.uuid = bm.uuid
         WHERE am.timestamp >= ? AND am.timestamp <= ?
         GROUP BY bm.session_id, am.model`,
      )
      .all(sinceEpoch, untilEpoch) as Array<{
      session_id: string;
      model: string;
      total_cost: number;
      total_duration: number;
      msg_count: number;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      model: r.model,
      totalCostUsd: r.total_cost,
      totalDurationMs: r.total_duration,
      messageCount: r.msg_count,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

// ── Conversation signal scanning (driven by standard sections) ──

export function scanConversationSignals(
  sessionIds: Set<string>,
  standard: EvalStandard,
  maxSessionsToScan: number = 50,
  claudeDir: string = DEFAULT_CLAUDE_DIR,
): ClaudeCodeConversationSignal[] {
  const { projectsDir } = resolvePaths(claudeDir);
  if (!existsSync(projectsDir)) return [];

  const isNoise = buildNoiseFilter(standard);

  // Build keyword lists per section
  const sectionKeywords = standard.sections.map((sec) => ({
    sectionId: sec.id,
    keywords: sec.keywords,
  }));

  const signals: ClaudeCodeConversationSignal[] = [];
  let scannedCount = 0;

  for (const projectDir of readdirSync(projectsDir)) {
    if (scannedCount >= maxSessionsToScan) break;
    const projectPath = join(projectsDir, projectDir);

    let entries: string[];
    try {
      entries = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const sid = file.replace(".jsonl", "");
      if (!sessionIds.has(sid)) continue;
      if (scannedCount >= maxSessionsToScan) break;
      scannedCount++;

      try {
        const content = readFileSync(join(projectPath, file), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed.type !== "user") continue;

          const msg = parsed.message as { content?: unknown } | undefined;
          if (!msg?.content) continue;

          const text =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? (msg.content as Array<{ text?: string }>)
                    .map((c) => c.text ?? "")
                    .join(" ")
                : "";

          if (isNoise(text)) continue;

          const lowerText = text.toLowerCase();
          const timestamp = (parsed.timestamp as string) ?? "";

          // Check keywords for each section
          for (const { sectionId, keywords } of sectionKeywords) {
            const hits = keywords.filter((k) =>
              lowerText.includes(k.toLowerCase()),
            );
            if (hits.length > 0) {
              signals.push({
                sessionId: sid,
                timestamp,
                type: sectionId as ClaudeCodeConversationSignal["type"],
                content: text.slice(0, 200),
                keywords: hits,
              });
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return signals;
}
