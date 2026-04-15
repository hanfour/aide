import chalk from "chalk";
import type { EvalReport, EvalSectionResult } from "../types.js";
import { localizeWarningLabel, t, type AppLocale } from "../i18n.js";

function fmtNum(n: number, locale: AppLocale): string {
  return n.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en-US");
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderTextReport(report: EvalReport, locale: AppLocale): string {
  const dict = t(locale);
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold.yellow("═".repeat(60)));
  lines.push(chalk.bold.yellow(`  ${report.standardName}`));
  lines.push(chalk.bold.yellow(`  ${dict.reportTitle}`));
  lines.push(chalk.bold.yellow("═".repeat(60)));
  lines.push("");
  lines.push(`  ${chalk.dim(`${dict.period}:`)}    ${report.period.since} ~ ${report.period.until}`);
  lines.push(`  ${chalk.dim(`${dict.generated}:`)} ${report.generatedAt}`);
  if (report.meta?.engineer) lines.push(`  ${chalk.dim(`${dict.engineer}:`)}  ${report.meta.engineer}`);
  if (report.meta?.department) lines.push(`  ${chalk.dim(`${dict.department}:`)} ${report.meta.department}`);

  if (report.dataWarnings.length > 0) {
    lines.push("");
    lines.push(`  ${chalk.yellow.bold(`⚠ ${dict.dataWarnings}`)}`);
    for (const w of report.dataWarnings) {
      const icon = w.severity === "missing" ? chalk.red("✗") : chalk.yellow("△");
      lines.push(`    ${icon} [${localizeWarningLabel(locale, w)}] ${w.source}: ${w.message}`);
    }
  }

  lines.push(sectionHeader(`1. ${dict.summaryTitle.toUpperCase()}`));
  lines.push("");
  lines.push(`  ${chalk.bold(report.managementSummary.headline)}`);
  lines.push(`  ${chalk.dim(report.managementSummary.overallAssessment)}`);
  lines.push("");
  lines.push(`  ${chalk.bold(dict.observations)}`);
  for (const item of report.managementSummary.observations) {
    lines.push(`    ${chalk.dim("•")} ${item}`);
  }
  lines.push("");
  lines.push(`  ${chalk.bold(dict.recommendations)}`);
  for (const item of report.managementSummary.recommendations) {
    lines.push(`    ${chalk.dim("•")} ${item}`);
  }

  lines.push(sectionHeader(`2. ${dict.usageTitle.toUpperCase()}`));
  lines.push("");
  const cc = report.usage.claudeCode;
  lines.push(chalk.bold.blue(`  ${dict.claudeLabel}`));
  lines.push(`    ${dict.sessions}:        ${fmtNum(cc.totalSessions, locale)}`);
  lines.push(
    `    ${dict.tokens}:          ${fmtNum(cc.totalInputTokens + cc.totalOutputTokens, locale)} (in: ${fmtNum(cc.totalInputTokens, locale)} / out: ${fmtNum(cc.totalOutputTokens, locale)})`,
  );
  if (cc.totalCostUsd > 0) lines.push(`    ${dict.estimatedCost}:  ${fmtCost(cc.totalCostUsd)}`);
  lines.push(`    ${dict.duration}:        ${fmtNum(cc.totalDurationMinutes, locale)} min`);
  lines.push(`    ${dict.activeDays}:     ${cc.activeDays}`);
  if (Object.keys(cc.models).length > 0) {
    lines.push(`    ${chalk.dim(`${dict.models}:`)}`);
    for (const [model, data] of Object.entries(cc.models).sort(([, a], [, b]) => b.tokens - a.tokens)) {
      lines.push(`      ${model}: ${data.sessions} sessions, ${fmtNum(data.tokens, locale)} tokens, ${fmtCost(data.cost)}`);
    }
  }
  if (cc.topProjects.length > 0) {
    lines.push(`    ${chalk.dim(`${dict.topProjects}:`)}`);
    for (const p of cc.topProjects.slice(0, 5)) {
      lines.push(`      ${p.path}: ${p.sessions} sessions, ${fmtNum(p.tokens, locale)} tokens`);
    }
  }
  if (Object.keys(cc.toolUsage).length > 0) {
    lines.push(`    ${chalk.dim(`${dict.topTools}:`)}`);
    for (const [tool, count] of Object.entries(cc.toolUsage).sort(([, a], [, b]) => b - a).slice(0, 8)) {
      lines.push(`      ${tool}: ${fmtNum(count, locale)}`);
    }
  }

  const cx = report.usage.codex;
  lines.push("");
  lines.push(chalk.bold.green(`  ${dict.codexLabel}`));
  if (cx.totalSessions === 0) {
    lines.push(`    ${chalk.dim(dict.noCodexSessions)}`);
  } else {
    lines.push(`    ${dict.sessions}:        ${fmtNum(cx.totalSessions, locale)}`);
    lines.push(`    ${dict.tokens}:          ${fmtNum(cx.totalTokensUsed, locale)}`);
    lines.push(`    ${dict.activeDays}:     ${cx.activeDays}`);
    if (Object.keys(cx.models).length > 0) {
      lines.push(`    ${chalk.dim(`${dict.models}:`)}`);
      for (const [model, data] of Object.entries(cx.models).sort(([, a], [, b]) => b.tokens - a.tokens)) {
        lines.push(`      ${model}: ${data.sessions} sessions, ${fmtNum(data.tokens, locale)} tokens`);
      }
    }
  }
  lines.push(`    ${chalk.dim(dict.scoringSourceNote)}`);

  report.sections.forEach((sec, idx) => {
    lines.push(sectionHeader(`${idx + 3}. ${sec.name.toUpperCase()}`));
    lines.push("");
    lines.push(`  ${chalk.dim(sec.summary)}`);
    lines.push("");
    if (sec.usageEvidence.length > 0) {
      lines.push(`  ${chalk.bold(dict.usageEvidence)}`);
      for (const item of sec.usageEvidence) lines.push(`    ${chalk.dim("•")} ${item}`);
      lines.push("");
    }
    if (sec.scoreEvidence.length > 0) {
      lines.push(`  ${chalk.bold(dict.scoreEvidence)}`);
      for (const item of sec.scoreEvidence) lines.push(`    ${chalk.dim("•")} ${item}`);
      lines.push("");
    }
    const groups = groupSignals(sec.signals);
    for (const [type, items] of Object.entries(groups)) {
      if (type.startsWith("keyword_")) continue;
      lines.push(`  ${chalk.bold(formatSignalType(type))} (${items.length})`);
      for (const item of items.slice(0, 3)) {
        lines.push(`    ${chalk.dim("•")} ${item.description}`);
        if (item.detail) lines.push(`      ${chalk.dim(truncate(item.detail, 120))}`);
      }
      if (items.length > 3) lines.push(chalk.dim(`    ... and ${items.length - 3} more`));
      lines.push("");
    }
  });

  const scoreIdx = report.sections.length + 3;
  lines.push(sectionHeader(`${scoreIdx}. ${dict.scoreTitle.toUpperCase()}`));
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

export function renderJsonReport(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderMarkdownReport(report: EvalReport, locale: AppLocale): string {
  const dict = t(locale);
  const lines: string[] = [];
  lines.push(`# ${report.standardName} — ${dict.reportTitle}`);
  lines.push("");
  lines.push(`**${dict.period}:** ${report.period.since} ~ ${report.period.until}`);
  lines.push(`**${dict.generated}:** ${report.generatedAt}`);
  if (report.meta?.engineer) lines.push(`**${dict.engineer}:** ${report.meta.engineer}`);
  if (report.meta?.department) lines.push(`**${dict.department}:** ${report.meta.department}`);
  lines.push("");

  if (report.dataWarnings.length > 0) {
    lines.push(`> **${dict.dataWarnings}**`);
    for (const w of report.dataWarnings) {
      lines.push(`> - [${localizeWarningLabel(locale, w)}] ${w.source}: ${w.message}`);
    }
    lines.push("");
  }

  lines.push(`## 1. ${dict.summaryTitle}`);
  lines.push("");
  lines.push(`**Headline:** ${report.managementSummary.headline}`);
  lines.push("");
  lines.push(report.managementSummary.overallAssessment);
  lines.push("");
  lines.push(`### ${dict.observations}`);
  for (const item of report.managementSummary.observations) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`### ${dict.recommendations}`);
  for (const item of report.managementSummary.recommendations) lines.push(`- ${item}`);
  lines.push("");

  lines.push(`## 2. ${dict.usageTitle}`);
  lines.push("");
  lines.push(`### ${dict.claudeLabel}`);
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  const cc = report.usage.claudeCode;
  lines.push(`| ${dict.sessions} | ${fmtNum(cc.totalSessions, locale)} |`);
  lines.push(`| ${dict.tokens} | ${fmtNum(cc.totalInputTokens + cc.totalOutputTokens, locale)} |`);
  if (cc.totalCostUsd > 0) lines.push(`| ${dict.estimatedCost} | ${fmtCost(cc.totalCostUsd)} |`);
  lines.push(`| ${dict.duration} | ${fmtNum(cc.totalDurationMinutes, locale)} min |`);
  lines.push(`| ${dict.activeDays} | ${cc.activeDays} |`);
  lines.push("");

  const cx = report.usage.codex;
  lines.push(`### ${dict.codexLabel}`);
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| ${dict.sessions} | ${fmtNum(cx.totalSessions, locale)} |`);
  lines.push(`| ${dict.tokens} | ${fmtNum(cx.totalTokensUsed, locale)} |`);
  lines.push(`| ${dict.activeDays} | ${cx.activeDays} |`);
  lines.push("");
  lines.push(`_${dict.scoringSourceNote}_`);
  lines.push("");

  report.sections.forEach((sec, idx) => {
    lines.push(`## ${idx + 3}. ${sec.name}`);
    lines.push("");
    lines.push(sec.summary);
    lines.push("");
    if (sec.usageEvidence.length > 0) {
      lines.push(`### ${dict.usageEvidence}`);
      for (const item of sec.usageEvidence) lines.push(`- ${item}`);
      lines.push("");
    }
    if (sec.scoreEvidence.length > 0) {
      lines.push(`### ${dict.scoreEvidence}`);
      for (const item of sec.scoreEvidence) lines.push(`- ${item}`);
      lines.push("");
    }
    for (const sig of sec.signals.filter((s) => !s.type.startsWith("keyword_")).slice(0, 10)) {
      lines.push(`- **${formatSignalType(sig.type)}**: ${sig.description}`);
      if (sig.detail) lines.push(`  > ${truncate(sig.detail, 150)}`);
    }
    lines.push("");
  });

  const scoreIdx = report.sections.length + 3;
  lines.push(`## ${scoreIdx}. ${dict.scoreTitle}`);
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

function renderSectionCards(report: EvalReport): string {
  return report.sections
    .map((sec) => {
      const signals = sec.signals
        .filter((sig) => !sig.type.startsWith("keyword_"))
        .slice(0, 6)
        .map(
          (sig) =>
            `<li><strong>${escapeHtml(formatSignalType(sig.type))}:</strong> ${escapeHtml(sig.description)}${
              sig.detail ? `<div class="signal-detail">${escapeHtml(truncate(sig.detail, 180))}</div>` : ""
            }</li>`,
        )
        .join("");
      const usageEvidence = sec.usageEvidence
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
      const scoreEvidence = sec.scoreEvidence
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
      return `
        <section class="section-card" id="section-${escapeHtml(sec.id)}">
          <div class="section-head">
            <div>
              <h2>${escapeHtml(sec.name)}</h2>
              <p class="section-summary">${escapeHtml(sec.summary)}</p>
            </div>
            <div class="score-pill ${sec.score > 100 ? "superior" : "standard"}">${sec.score}%</div>
          </div>
          <div class="section-grid">
            <div class="evidence-card">
              <h3>Usage Evidence</h3>
              <ul>${usageEvidence || "<li>None</li>"}</ul>
            </div>
            <div class="evidence-card">
              <h3>Score Evidence</h3>
              <ul>${scoreEvidence || "<li>None</li>"}</ul>
            </div>
          </div>
          <div class="reason-box">${escapeHtml(sec.reason)}</div>
          <div class="signal-box">
            <h3>Signals</h3>
            <ul>${signals || "<li>None</li>"}</ul>
          </div>
        </section>
      `;
    })
    .join("\n");
}

export function renderHtmlReport(report: EvalReport, locale: AppLocale): string {
  const dict = t(locale);
  const cc = report.usage.claudeCode;
  const cx = report.usage.codex;
  const warnings = report.dataWarnings
    .map(
      (w) =>
        `<li><strong>${escapeHtml(localizeWarningLabel(locale, w))}</strong> ${escapeHtml(w.source)}: ${escapeHtml(w.message)}</li>`,
    )
    .join("");
  const observations = report.managementSummary.observations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const recommendations = report.managementSummary.recommendations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const sectionLinks = report.sections
    .map((sec) => `<a href="#section-${escapeHtml(sec.id)}">${escapeHtml(sec.name)}</a>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(report.standardName)} - ${escapeHtml(dict.reportTitle)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Inter", "Noto Sans TC", sans-serif; background: #f4f7fb; color: #1f2937; line-height: 1.6; }
    .container { max-width: 1120px; margin: 0 auto; padding: 40px 20px 64px; }
    .hero { background: linear-gradient(135deg, #ffffff 0%, #edf4ff 100%); border: 1px solid #dbe7f7; border-radius: 20px; padding: 28px; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08); }
    .hero h1 { margin: 0 0 8px; font-size: 34px; color: #0f172a; }
    .subtitle { color: #64748b; font-size: 15px; margin-bottom: 18px; }
    .meta-grid, .stats-row, .section-grid, .usage-grid { display: grid; gap: 16px; }
    .meta-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .meta-card, .stat-card, .content-card, .evidence-card, .usage-card, .section-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; }
    .meta-card, .stat-card, .content-card, .evidence-card, .usage-card { padding: 18px; }
    .meta-label, .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }
    .meta-value, .stat-value { margin-top: 6px; font-weight: 700; color: #0f172a; }
    .nav-toc { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .nav-toc a { text-decoration: none; color: #1d4ed8; background: #dbeafe; padding: 8px 12px; border-radius: 999px; font-size: 13px; }
    .stats-row, .usage-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-top: 24px; }
    .stat-value { font-size: 28px; }
    .content-grid { display: grid; gap: 20px; margin-top: 28px; }
    .content-card h2, .usage-card h2, .section-card h2 { margin: 0 0 12px; font-size: 22px; color: #0f172a; }
    .list { margin: 0; padding-left: 20px; }
    .list li { margin-bottom: 8px; }
    .warning-list li { color: #991b1b; }
    .usage-grid { margin-top: 16px; }
    .usage-card .mini { color: #64748b; font-size: 14px; margin-bottom: 12px; }
    .mini-list { margin: 0; padding-left: 18px; font-size: 14px; }
    .section-card { padding: 22px; margin-top: 20px; }
    .section-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .section-summary { margin: 8px 0 0; color: #64748b; }
    .score-pill { min-width: 92px; text-align: center; border-radius: 999px; padding: 10px 14px; font-weight: 700; }
    .score-pill.superior { background: #dcfce7; color: #166534; }
    .score-pill.standard { background: #dbeafe; color: #1d4ed8; }
    .section-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 16px; }
    .reason-box { margin-top: 16px; background: #fff7ed; border: 1px solid #fdba74; border-radius: 12px; padding: 14px; color: #9a3412; }
    .signal-box { margin-top: 16px; }
    .signal-box ul { margin: 0; padding-left: 18px; }
    .signal-detail { color: #64748b; font-size: 13px; margin-top: 4px; }
    @media (max-width: 720px) { .container { padding: 20px 12px 40px; } .hero h1 { font-size: 28px; } .section-head { flex-direction: column; } }
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <h1>${escapeHtml(report.standardName)}</h1>
      <div class="subtitle">${escapeHtml(dict.reportTitle)} | ${escapeHtml(report.period.since)} to ${escapeHtml(report.period.until)}</div>
      <div class="meta-grid">
        <div class="meta-card"><div class="meta-label">${escapeHtml(dict.period)}</div><div class="meta-value">${escapeHtml(report.period.since)} ~ ${escapeHtml(report.period.until)}</div></div>
        <div class="meta-card"><div class="meta-label">${escapeHtml(dict.generated)}</div><div class="meta-value">${escapeHtml(report.generatedAt)}</div></div>
        <div class="meta-card"><div class="meta-label">${escapeHtml(dict.engineer)}</div><div class="meta-value">${escapeHtml(report.meta?.engineer ?? "-")}</div></div>
        <div class="meta-card"><div class="meta-label">${escapeHtml(dict.department)}</div><div class="meta-value">${escapeHtml(report.meta?.department ?? "-")}</div></div>
      </div>
      <nav class="nav-toc">
        <a href="#summary">${escapeHtml(dict.summaryTitle)}</a>
        <a href="#usage">${escapeHtml(dict.usageTitle)}</a>
        ${sectionLinks}
      </nav>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-label">${escapeHtml(dict.sessions)}</div><div class="stat-value">${fmtNum(cc.totalSessions + cx.totalSessions, locale)}</div></div>
        <div class="stat-card"><div class="stat-label">${escapeHtml(dict.tokens)}</div><div class="stat-value">${fmtNum(cc.totalInputTokens + cc.totalOutputTokens + cx.totalTokensUsed, locale)}</div></div>
        <div class="stat-card"><div class="stat-label">${escapeHtml(dict.activeDays)}</div><div class="stat-value">${fmtNum(Math.max(cc.activeDays, cx.activeDays), locale)}</div></div>
        <div class="stat-card"><div class="stat-label">${escapeHtml(dict.sections)}</div><div class="stat-value">${fmtNum(report.sections.length, locale)}</div></div>
      </div>
    </section>

    <div class="content-grid">
      <section class="content-card" id="summary">
        <h2>${escapeHtml(dict.atAGlance)}</h2>
        <p>${escapeHtml(report.managementSummary.headline)}</p>
        <p>${escapeHtml(report.managementSummary.overallAssessment)}</p>
        <h3>${escapeHtml(dict.observations)}</h3>
        <ul class="list">${observations}</ul>
        <h3>${escapeHtml(dict.recommendations)}</h3>
        <ul class="list">${recommendations}</ul>
      </section>

      ${
        report.dataWarnings.length > 0
          ? `<section class="content-card"><h2>${escapeHtml(dict.dataWarnings)}</h2><ul class="list warning-list">${warnings}</ul></section>`
          : ""
      }

      <section class="content-card" id="usage">
        <h2>${escapeHtml(dict.usageStats)}</h2>
        <p>${escapeHtml(dict.scoringSourceNote)}</p>
        <div class="usage-grid">
          <div class="usage-card">
            <h2>${escapeHtml(dict.claudeLabel)}</h2>
            <div class="mini">${fmtNum(cc.totalSessions, locale)} sessions • ${fmtNum(cc.totalInputTokens + cc.totalOutputTokens, locale)} tokens • ${fmtCost(cc.totalCostUsd)}</div>
            <ul class="mini-list">
              <li>${escapeHtml(dict.activeDays)}: ${cc.activeDays}</li>
              <li>${escapeHtml(dict.duration)}: ${fmtNum(cc.totalDurationMinutes, locale)} min</li>
            </ul>
          </div>
          <div class="usage-card">
            <h2>${escapeHtml(dict.codexLabel)}</h2>
            <div class="mini">${fmtNum(cx.totalSessions, locale)} sessions • ${fmtNum(cx.totalTokensUsed, locale)} tokens</div>
            <ul class="mini-list">
              <li>${escapeHtml(dict.activeDays)}: ${cx.activeDays}</li>
              <li>${escapeHtml(dict.models)}: ${escapeHtml(Object.keys(cx.models).join(", ") || "-")}</li>
            </ul>
          </div>
        </div>
      </section>

      ${renderSectionCards(report)}
    </div>
  </div>
</body>
</html>`;
}
