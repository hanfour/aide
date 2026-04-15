import chalk from "chalk";
import type { EvalReport, EvalSectionResult } from "../types.js";

// ── Helpers ──

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function scoreColor(score: number, label: string): string {
  return score > 100
    ? chalk.green.bold(`${score}% (${label})`)
    : chalk.cyan.bold(`${score}% (${label})`);
}

function sectionHeader(title: string): string {
  const line = "━".repeat(60);
  return `\n${chalk.bold(line)}\n${chalk.bold.white(title)}\n${chalk.bold(line)}`;
}

function formatSignalType(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function truncate(str: string, maxLen: number): string {
  const clean = str.replace(/\n/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}

function groupSignals(
  signals: EvalSectionResult["signals"],
): Record<string, EvalSectionResult["signals"]> {
  const groups: Record<string, EvalSectionResult["signals"]> = {};
  for (const s of signals) {
    const arr = groups[s.type] ?? [];
    arr.push(s);
    groups[s.type] = arr;
  }
  return groups;
}

// ── Text report ──

export function renderTextReport(report: EvalReport): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(chalk.bold.yellow("═".repeat(60)));
  lines.push(chalk.bold.yellow(`  ${report.standardName}`));
  lines.push(chalk.bold.yellow("  Evaluation Report / 評核報告"));
  lines.push(chalk.bold.yellow("═".repeat(60)));
  lines.push("");
  lines.push(
    `  ${chalk.dim("Period:")}    ${report.period.since} ~ ${report.period.until}`,
  );
  lines.push(`  ${chalk.dim("Generated:")} ${report.generatedAt}`);
  if (report.meta?.engineer)
    lines.push(`  ${chalk.dim("Engineer:")}  ${report.meta.engineer}`);
  if (report.meta?.department)
    lines.push(`  ${chalk.dim("Department:")} ${report.meta.department}`);

  // Data quality warnings
  if (report.dataWarnings.length > 0) {
    lines.push("");
    lines.push(
      `  ${chalk.yellow.bold("⚠ DATA QUALITY WARNINGS / 資料品質警告")}`,
    );
    for (const w of report.dataWarnings) {
      const icon =
        w.severity === "missing" ? chalk.red("✗") : chalk.yellow("△");
      lines.push(`    ${icon} [${w.source}] ${w.message}`);
    }
  }

  lines.push(sectionHeader("1. MANAGEMENT SUMMARY / 管理摘要"));
  lines.push("");
  lines.push(`  ${chalk.bold(report.managementSummary.headline)}`);
  lines.push(`  ${chalk.dim(report.managementSummary.overallAssessment)}`);
  lines.push("");
  lines.push(`  ${chalk.bold("Observations")}`);
  for (const item of report.managementSummary.observations) {
    lines.push(`    ${chalk.dim("•")} ${item}`);
  }
  lines.push("");
  lines.push(`  ${chalk.bold("Recommendations")}`);
  for (const item of report.managementSummary.recommendations) {
    lines.push(`    ${chalk.dim("•")} ${item}`);
  }

  // ── Usage Overview ──
  lines.push(sectionHeader("2. USAGE OVERVIEW / 使用概覽"));
  lines.push("");

  const cc = report.usage.claudeCode;
  lines.push(chalk.bold.blue("  Claude Code"));
  lines.push(`    Sessions:        ${fmtNum(cc.totalSessions)}`);
  lines.push(
    `    Tokens:          ${fmtNum(cc.totalInputTokens + cc.totalOutputTokens)} (in: ${fmtNum(cc.totalInputTokens)} / out: ${fmtNum(cc.totalOutputTokens)})`,
  );
  if (cc.totalCostUsd > 0)
    lines.push(`    Estimated Cost:  ${fmtCost(cc.totalCostUsd)}`);
  lines.push(`    Duration:        ${fmtNum(cc.totalDurationMinutes)} min`);
  lines.push(`    Active Days:     ${cc.activeDays}`);
  if (Object.keys(cc.models).length > 0) {
    lines.push(`    ${chalk.dim("Models:")}`);
    for (const [model, data] of Object.entries(cc.models).sort(
      ([, a], [, b]) => b.tokens - a.tokens,
    )) {
      lines.push(
        `      ${model}: ${data.sessions} sessions, ${fmtNum(data.tokens)} tokens, ${fmtCost(data.cost)}`,
      );
    }
  }
  if (cc.topProjects.length > 0) {
    lines.push(`    ${chalk.dim("Top Projects:")}`);
    for (const p of cc.topProjects.slice(0, 5)) {
      lines.push(
        `      ${p.path}: ${p.sessions} sessions, ${fmtNum(p.tokens)} tokens`,
      );
    }
  }
  if (Object.keys(cc.toolUsage).length > 0) {
    lines.push(`    ${chalk.dim("Top Tools:")}`);
    for (const [tool, count] of Object.entries(cc.toolUsage)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)) {
      lines.push(`      ${tool}: ${fmtNum(count)}`);
    }
  }

  const cx = report.usage.codex;
  lines.push("");
  lines.push(chalk.bold.green("  Codex"));
  if (cx.totalSessions === 0) {
    lines.push(`    ${chalk.dim("No Codex sessions found.")}`);
  } else {
    lines.push(`    Sessions:        ${fmtNum(cx.totalSessions)}`);
    lines.push(`    Tokens:          ${fmtNum(cx.totalTokensUsed)}`);
    lines.push(`    Active Days:     ${cx.activeDays}`);
    if (Object.keys(cx.models).length > 0) {
      lines.push(`    ${chalk.dim("Models:")}`);
      for (const [model, data] of Object.entries(cx.models)) {
        lines.push(
          `      ${model}: ${data.sessions} sessions, ${fmtNum(data.tokens)} tokens`,
        );
      }
    }
  }
  lines.push(
    `    ${chalk.dim("Scoring uses Claude Code facets/conversations plus Codex thread metadata, user prompt history, and tool/error logs.")}`,
  );

  // ── Dynamic sections from standard ──
  report.sections.forEach((sec, idx) => {
    lines.push(sectionHeader(`${idx + 3}. ${sec.name.toUpperCase()}`));
    lines.push("");
    lines.push(`  ${chalk.dim(sec.summary)}`);
    lines.push("");

    if (sec.usageEvidence.length > 0) {
      lines.push(`  ${chalk.bold("Usage Evidence")}`);
      for (const item of sec.usageEvidence) {
        lines.push(`    ${chalk.dim("•")} ${item}`);
      }
      lines.push("");
    }

    if (sec.scoreEvidence.length > 0) {
      lines.push(`  ${chalk.bold("Score Evidence")}`);
      for (const item of sec.scoreEvidence) {
        lines.push(`    ${chalk.dim("•")} ${item}`);
      }
      lines.push("");
    }

    const groups = groupSignals(sec.signals);
    for (const [type, items] of Object.entries(groups)) {
      // Skip keyword signals in the evidence section (show them in score)
      if (type.startsWith("keyword_")) continue;
      lines.push(`  ${chalk.bold(formatSignalType(type))} (${items.length})`);
      for (const item of items.slice(0, 3)) {
        lines.push(`    ${chalk.dim("•")} ${item.description}`);
        if (item.detail)
          lines.push(`      ${chalk.dim(truncate(item.detail, 120))}`);
      }
      if (items.length > 3)
        lines.push(chalk.dim(`    ... and ${items.length - 3} more`));
      lines.push("");
    }
  });

  // ── Score Recommendation ──
  const scoreIdx = report.sections.length + 3;
  lines.push(sectionHeader(`${scoreIdx}. SCORE RECOMMENDATION / 分值建議`));
  lines.push("");

  for (const sec of report.sections) {
    lines.push(`  ${chalk.bold(sec.name)} (Weight: ${sec.weight} in KPI)`);
    lines.push(`    Score: ${scoreColor(sec.score, sec.label)}`);
    lines.push(`    ${chalk.dim(sec.reason)}`);
    lines.push("");
  }

  lines.push(chalk.bold.yellow("═".repeat(60)));
  lines.push("");

  return lines.join("\n");
}

// ── JSON report ──

export function renderJsonReport(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Markdown report ──

export function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.standardName} — Evaluation Report / 評核報告`);
  lines.push("");
  lines.push(`**Period:** ${report.period.since} ~ ${report.period.until}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  if (report.meta?.engineer)
    lines.push(`**Engineer:** ${report.meta.engineer}`);
  if (report.meta?.department)
    lines.push(`**Department:** ${report.meta.department}`);
  lines.push("");

  if (report.dataWarnings.length > 0) {
    lines.push("> **Data Quality Warnings / 資料品質警告**");
    for (const w of report.dataWarnings) {
      const icon = w.severity === "missing" ? "**MISSING**" : "PARTIAL";
      lines.push(`> - [${icon}] ${w.source}: ${w.message}`);
    }
    lines.push("");
  }

  lines.push("## 1. Management Summary / 管理摘要");
  lines.push("");
  lines.push(`**Headline:** ${report.managementSummary.headline}`);
  lines.push("");
  lines.push(report.managementSummary.overallAssessment);
  lines.push("");
  lines.push("### Observations");
  for (const item of report.managementSummary.observations) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("### Recommendations");
  for (const item of report.managementSummary.recommendations) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // Usage
  lines.push("## 2. Usage Overview / 使用概覽");
  lines.push("");
  lines.push("### Claude Code");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  const cc2 = report.usage.claudeCode;
  lines.push(`| Sessions | ${fmtNum(cc2.totalSessions)} |`);
  lines.push(
    `| Tokens | ${fmtNum(cc2.totalInputTokens + cc2.totalOutputTokens)} |`,
  );
  if (cc2.totalCostUsd > 0)
    lines.push(`| Cost | ${fmtCost(cc2.totalCostUsd)} |`);
  lines.push(`| Duration | ${fmtNum(cc2.totalDurationMinutes)} min |`);
  lines.push(`| Active Days | ${cc2.activeDays} |`);
  lines.push("");
  if (Object.keys(cc2.models).length > 0) {
    lines.push("#### Claude Code Models");
    lines.push("| Model | Sessions | Tokens | Cost |");
    lines.push("|-------|----------|--------|------|");
    for (const [model, data] of Object.entries(cc2.models).sort(
      ([, a], [, b]) => b.tokens - a.tokens,
    )) {
      lines.push(
        `| ${model} | ${data.sessions} | ${fmtNum(data.tokens)} | ${fmtCost(data.cost)} |`,
      );
    }
    lines.push("");
  }

  const cx2 = report.usage.codex;
  if (cx2.totalSessions > 0) {
    lines.push("### Codex");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Sessions | ${fmtNum(cx2.totalSessions)} |`);
    lines.push(`| Tokens | ${fmtNum(cx2.totalTokensUsed)} |`);
    lines.push(`| Active Days | ${cx2.activeDays} |`);
    lines.push("");
  }
  lines.push(
    "_Scoring uses Claude Code facets/conversations plus Codex thread metadata, user prompt history, and tool/error logs._",
  );
  lines.push("");

  // Dynamic sections
  report.sections.forEach((sec, idx) => {
    lines.push(`## ${idx + 3}. ${sec.name}`);
    lines.push("");
    lines.push(sec.summary);
    lines.push("");
    if (sec.usageEvidence.length > 0) {
      lines.push("### Usage Evidence");
      for (const item of sec.usageEvidence) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }
    if (sec.scoreEvidence.length > 0) {
      lines.push("### Score Evidence");
      for (const item of sec.scoreEvidence) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }
    for (const sig of sec.signals
      .filter((s) => !s.type.startsWith("keyword_"))
      .slice(0, 10)) {
      lines.push(`- **${formatSignalType(sig.type)}**: ${sig.description}`);
      if (sig.detail) lines.push(`  > ${truncate(sig.detail, 150)}`);
    }
    lines.push("");
  });

  // Score
  const scoreIdx = report.sections.length + 3;
  lines.push(`## ${scoreIdx}. Score Recommendation / 分值建議`);
  lines.push("");
  for (const sec of report.sections) {
    lines.push(`### ${sec.name} (Weight: ${sec.weight} in KPI)`);
    lines.push(`**Score: ${sec.score}%** (${sec.label})`);
    lines.push("");
    lines.push(sec.reason);
    lines.push("");
  }

  return lines.join("\n");
}
