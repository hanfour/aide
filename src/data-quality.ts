import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { DataQualityWarning } from "./types.js";

interface DataSourceCheck {
  name: string;
  path: string;
  required: boolean;
}

function buildSourceChecks(claudeDir: string, codexDir: string) {
  const claudeSources: DataSourceCheck[] = [
    { name: "Claude Code session-meta", path: join(claudeDir, "usage-data", "session-meta"), required: true },
    { name: "Claude Code facets", path: join(claudeDir, "usage-data", "facets"), required: false },
    { name: "Claude Code SQLite store", path: join(claudeDir, "__store.db"), required: false },
    { name: "Claude Code projects (JSONL)", path: join(claudeDir, "projects"), required: false },
  ];

  const codexSources: DataSourceCheck[] = [
    { name: "Codex state DB", path: join(codexDir, "state_5.sqlite"), required: false },
    { name: "Codex logs DB", path: join(codexDir, "logs_2.sqlite"), required: false },
    { name: "Codex history", path: join(codexDir, "history.jsonl"), required: false },
  ];

  return [...claudeSources, ...codexSources];
}

export function checkDataQuality(
  claudeSessionCount: number,
  codexSessionCount: number,
  facetCount: number,
  signalCount: number,
  claudeDir: string = join(homedir(), ".claude"),
  codexDir: string = join(homedir(), ".codex"),
): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  // Check data source existence
  for (const src of buildSourceChecks(claudeDir, codexDir)) {
    if (!existsSync(src.path)) {
      warnings.push({
        source: src.name,
        severity: src.required ? "missing" : "partial",
        message: `${src.name} not found at ${src.path}. ${src.required ? "This is a primary data source — results may be incomplete." : "Supplementary data will be unavailable."}`,
      });
    }
  }

  // Check data completeness
  if (claudeSessionCount === 0 && codexSessionCount === 0) {
    warnings.push({
      source: "All sources",
      severity: "missing",
      message: "No sessions found in the evaluation period from any data source. Check the date range or verify that AI tools have been used.",
    });
  }

  if (claudeSessionCount > 0 && facetCount === 0) {
    warnings.push({
      source: "Claude Code facets",
      severity: "partial",
      message: `${claudeSessionCount} sessions found but 0 facets. Facets provide session quality analysis (goals, outcomes, friction). Qualitative scoring may be limited.`,
    });
  }

  if (claudeSessionCount > 0 && signalCount === 0) {
    warnings.push({
      source: "Conversation signals",
      severity: "partial",
      message: "No conversation keyword signals detected. This may indicate the JSONL files are missing, or all user messages were filtered as noise.",
    });
  }

  return warnings;
}
