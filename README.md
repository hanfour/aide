# aide

**AI Development Performance Evaluator** — A CLI tool that reads local Claude Code and Codex usage data to generate technical performance evaluation reports, similar to [ccusage](https://github.com/ryoppippi/ccusage).

**AI 開發績效評核工具** — 一個 CLI 工具，讀取本地端 Claude Code 與 Codex 的使用資料，以技術績效審核者的角色產出評核報告。

---

## Why / 為什麼需要這個工具

Engineering managers need evidence-based data to evaluate how effectively their team uses AI coding assistants. Manual review of hundreds of AI sessions is impractical. This tool automates the process by:

研發經理需要基於證據的資料來評估團隊使用 AI 程式助手的成效。手動審查數百個 AI 工作階段不切實際。本工具透過以下方式自動化此流程：

1. **Extracting** usage data from local Claude Code (`~/.claude/`) and Codex (`~/.codex/`) storage
2. **Analyzing** session patterns for decision-making quality and risk identification
3. **Scoring** against a configurable evaluation standard (default: OneAD R&D standard)
4. **Generating** structured reports with evidence and score recommendations

---

## Features / 功能特色

- Reads Claude Code session metadata, facets, SQLite cost data, and JSONL conversations
- Reads Codex SQLite thread data (tokens, models, sessions)
- Detects decision-making patterns (iterative refinement, multi-task coordination, active corrections)
- Detects risk identification signals (security awareness, performance discussions, bug catching)
- Configurable evaluation standard — bring your own criteria, keywords, and thresholds
- Multiple output formats: terminal (colored), JSON, Markdown
- JSON output is machine-parseable (`--format json` emits clean JSON to stdout, progress logs go to stderr)
- Noise filtering to exclude system messages and code review templates from analysis
- `init-standard` command to export the default standard as a customization template
- Data quality warnings when data sources are missing or incomplete

---

## Data Sources / 資料來源

| Source | Path | Data |
|--------|------|------|
| Claude Code Session Meta | `~/.claude/usage-data/session-meta/*.json` | Tokens, duration, tools, languages, git commits, first prompt |
| Claude Code Facets | `~/.claude/usage-data/facets/*.json` | AI-generated session analysis: goals, outcomes, friction, helpfulness |
| Claude Code SQLite | `~/.claude/__store.db` | Per-message cost (USD), model, duration |
| Claude Code JSONL | `~/.claude/projects/*/*.jsonl` | Full conversation content for keyword signal scanning |
| Codex SQLite | `~/.codex/state_5.sqlite` | Threads: tokens_used, model, title, git info |
| Codex History | `~/.codex/history.jsonl` | Full user prompts by thread/session |
| Codex Logs | `~/.codex/logs_2.sqlite` | Thread-level tool calls and error events |

All data is read **locally and read-only**. No data is sent to any external service.

所有資料皆為**本地端唯讀存取**，不會傳送至任何外部服務。

---

## Prerequisites / 系統需求

- **Node.js** >= 18
- **npm** (included with Node.js)
- `~/.claude/` directory (from Claude Code usage)
- `~/.codex/` directory (from Codex CLI usage, optional)

---

## Installation / 安裝

### Option A: Clone and run locally / 本地 Clone 執行

```bash
# 1. Clone the repository
git clone <repo-url> ~/aide
cd ~/aide

# 2. Install dependencies
npm install

# 3. Build (compiles TypeScript to dist/)
npm run build

# 4. Verify installation
node dist/cli.js --version
```

### Option B: Development mode (no build required) / 開發模式

```bash
git clone <repo-url> ~/aide
cd ~/aide
npm install

# Run directly with tsx (TypeScript execution)
npx tsx src/cli.ts --help
```

### Option C: Global install via npm link / 全域安裝

```bash
cd ~/aide
npm install
npm run build
npm link

# Now available globally
aide --help
```

After `npm link`, the `aide` command is available system-wide. To unlink:

```bash
npm unlink -g aide
```

---

## Quick Start / 快速開始

```bash
# Quick usage summary (last 7 days)
npx tsx src/cli.ts summary

# Full evaluation report (last 30 days, terminal output)
npx tsx src/cli.ts report

# Save report as Markdown
npx tsx src/cli.ts report --format markdown --output report.md

# Monthly KPI report
npx tsx src/cli.ts monthly

# If globally installed via npm link:
aide summary
aide report
```

---

## Usage / 使用方式

### Quick Summary / 快速摘要

```bash
# Last 7 days (default)
npx tsx src/cli.ts summary

# Custom date range
npx tsx src/cli.ts summary --since 2026-03-01 --until 2026-03-31
```

Output:

```
AI Dev Usage Summary
Period: 2026-03-01 ~ 2026-03-31

Claude Code
  Sessions:    57
  Tokens:      259,336
  Duration:    15676 min
  Active Days: 9

Codex
  Sessions:    1
  Tokens:      368,930
  Active Days: 1
```

### Full Evaluation Report / 完整評核報告

```bash
# Default: last 30 days, text format, built-in OneAD standard
npx tsx src/cli.ts report

# Current calendar month
npx tsx src/cli.ts monthly

# Previous full calendar month
npx tsx src/cli.ts monthly --previous

# Current calendar quarter
npx tsx src/cli.ts quarterly

# Previous full calendar quarter
npx tsx src/cli.ts quarterly --previous

# Custom date range
npx tsx src/cli.ts report --since 2026-03-01 --until 2026-04-14

# Output as Markdown file
npx tsx src/cli.ts report --format markdown --output report.md

# Output as JSON (machine-parseable, clean stdout)
npx tsx src/cli.ts report --format json --output report.json

# Pipe JSON for programmatic consumption
npx tsx src/cli.ts report --format json 2>/dev/null | jq '.sections[].score'

# Use a custom evaluation standard
npx tsx src/cli.ts report --standard my-standard.json

# Include engineer/department metadata in report
npx tsx src/cli.ts report --engineer "Jane Doe" --department "R&D"
```

> **Note:** When using `--format json`, progress and status messages are written to stderr.
> stdout contains only the JSON report, making it safe to pipe to `jq` or other tools.

### Using the compiled CLI / 使用編譯後的 CLI

If you have run `npm run build`, you can use `node dist/cli.js` instead of `npx tsx src/cli.ts`:

```bash
node dist/cli.js report --since 2026-03-01 --until 2026-03-31
node dist/cli.js summary
node dist/cli.js monthly --previous --format markdown --output march.md
```

---

## CLI Reference / 命令參考

### `aide report`

Generate a full evaluation report.

```
Options:
  -s, --since <date>       Start date, YYYY-MM-DD (default: 30 days ago)
  -u, --until <date>       End date, YYYY-MM-DD (default: today)
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --engineer <name>        Engineer name for report identification
  --department <name>      Department name for report identification
```

### `aide summary`

Quick usage summary for a date range.

```
Options:
  -s, --since <date>       Start date, YYYY-MM-DD (default: 7 days ago)
  -u, --until <date>       End date, YYYY-MM-DD (default: today)
```

### `aide monthly`

Generate a monthly KPI report.

```
Options:
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --previous               Use the previous full calendar month
```

### `aide quarterly`

Generate a quarterly KPI report.

```
Options:
  -f, --format <format>    Output: text | json | markdown (default: text)
  -o, --output <file>      Write report to file instead of stdout
  --standard <path>        Path to custom evaluation standard JSON
  --previous               Use the previous full calendar quarter
```

### `aide init-standard`

Export the default evaluation standard as a JSON template for customization.

```
Options:
  -o, --output <file>      Output file path (default: eval-standard.json)
```

---

## Report Structure / 報告結構

The generated report contains the following sections:

### 1. Management Summary / 管理摘要

Management-facing overview for monthly/quarterly KPI review:

- Overall headline
- Period assessment
- Key observations
- Recommended follow-up actions

### 2. Usage Overview / 使用概覽

Quantitative metrics for both Claude Code and Codex:

- Total sessions, tokens (input/output), estimated cost
- Active days, duration
- Top projects by token usage
- Top tools used (Bash, Read, Edit, etc.)
- Model breakdown

### 3-N. Evaluation Sections / 評核區段

Each section defined in the evaluation standard generates:

- **Summary** — aggregate statistics
- **Usage evidence** — workload/depth indicators such as sessions, tool usage, follow-up prompts
- **Score evidence** — threshold-relevant evidence used for 100% / 120% scoring
- **Evidence signals** — grouped by type (iterative refinement, bugs caught, security awareness, etc.)
- **Metrics** — numeric indicators used for scoring

### Final. Score Recommendation / 分值建議

For each evaluation section:

- **Score**: Standard (100%) or Superior (120%)
- **Label**: Human-readable grade
- **Reason**: Evidence-backed explanation referencing the criteria

### Data Quality Warnings / 資料品質警告

The report includes data quality warnings when:

- Required data sources (`~/.claude/usage-data/session-meta`) are missing
- Sessions exist but no facets are found (qualitative analysis limited)
- No keyword signals detected (JSONL files may be missing)
- No sessions found at all in the evaluation period

---

## Custom Evaluation Standards / 自訂評核標準

The built-in default is the OneAD R&D AI-Application Evaluation Standard. To create your own:

### Step 1: Export the default template / 匯出預設範本

```bash
npx tsx src/cli.ts init-standard --output my-standard.json
```

### Step 2: Edit the JSON file / 編輯 JSON 檔案

Key fields you can customize:

| Field | Purpose |
|-------|---------|
| `name` | Standard name shown in report header |
| `sections[]` | Array of evaluation sections (add/remove/reorder) |
| `sections[].id` | Unique section identifier |
| `sections[].name` | Section display name |
| `sections[].weight` | KPI weight (display only) |
| `sections[].keywords` | Conversation scanning keywords |
| `sections[].thresholds` | Numeric thresholds for Superior score |
| `sections[].superiorRules` | Optional rule for combining thresholds |
| `sections[].standard` | 100% score criteria text |
| `sections[].superior` | 120% score criteria text |
| `noiseFilters` | Rules to exclude system/template messages |

### Step 3: Use it / 使用自訂標準

```bash
npx tsx src/cli.ts report --standard my-standard.json
```

### Example: Adding a new section / 新增評核區段範例

```json
{
  "id": "collaboration",
  "name": "AI-Human Collaboration Quality",
  "weight": "30%",
  "standard": {
    "score": 100,
    "label": "Standard",
    "criteria": ["Uses AI for routine tasks", "Follows AI suggestions without modification"]
  },
  "superior": {
    "score": 120,
    "label": "Superior",
    "criteria": ["Actively debates with AI on design decisions", "Synthesizes multiple AI suggestions into novel solutions"]
  },
  "keywords": ["design", "architecture", "trade-off", "pattern", "alternative"],
  "thresholds": {
    "iterativeRatio": 0.4,
    "keywordHits": 15
  },
  "superiorRules": {
    "mode": "grouped",
    "strongThresholds": ["iterativeRatio", "keywordHits"],
    "supportThresholds": ["avgToolUses"],
    "minStrongMatched": 1,
    "minSupportMatched": 0
  }
}
```

### Superior Rules / 升等規則

`superiorRules.mode = "any"` — any matched threshold is enough for 120%.

`superiorRules.mode = "grouped"` — separate strong evidence from support evidence. Strong evidence must meet a minimum count; support evidence alone is not sufficient.

Keys referenced by `strongThresholds` and `supportThresholds` must also exist in `thresholds`.

### Available threshold keys / 可用門檻鍵值

| Key | Description |
|-----|-------------|
| `iterativeRatio` | Ratio of iterative/multi-task sessions to total |
| `correctionCount` | Number of user corrections/interruptions |
| `keywordHits` | Number of keyword signal matches |
| `avgToolUses` | Average tool uses per session |
| `securityCount` | Security-related keyword matches |
| `performanceCount` | Performance-related keyword matches |
| `bugsCaught` | AI-generated bugs caught (from facets) |
| `frictionSessions` | Sessions with friction events |
| `codexIterativeSessions` | Codex threads with strong iterative evidence |
| `codexMultiTurnSessions` | Codex multi-turn threads |
| `codexFollowUpCount` | Codex follow-up user prompts |
| `codexDeepSessions` | Codex high-depth threads |
| `codexErrorSessions` | Codex threads with logged errors |

---

## Default Evaluation Standard / 預設評核標準

The built-in OneAD standard evaluates two dimensions:

### AI Interaction & Decision (20% KPI weight) / AI 交互與決策

| Grade | Criteria |
|-------|----------|
| **Standard (100%)** | Actively use AI for coding; clear decision notes |
| **Superior (120%)** | Multi-iteration guidance (A->B->C); system-constraint-aware optimization |

### AI Identification & Risk Control (50% KPI weight) / AI 識別與風險控管

| Grade | Criteria |
|-------|----------|
| **Standard (100%)** | Catch common AI errors/hallucinations; stable code |
| **Superior (120%)** | Identify critical risks (security, performance, memory); produce SOP/Wiki for team sharing |

---

## Architecture / 架構

```
src/
├── cli.ts                    # CLI entry point (commander)
├── types.ts                  # TypeScript type definitions
├── standard.ts               # Load & validate evaluation standards
├── period.ts                 # Date period resolution (monthly/quarterly)
├── data-quality.ts           # Data source completeness checks
├── utils.ts                  # Shared utilities (noise filter)
├── extractors/
│   ├── claude-code.ts        # Read ~/.claude/ data (JSONL, SQLite, JSON)
│   └── codex.ts              # Read ~/.codex/ data (SQLite, JSONL)
├── analyzers/
│   ├── usage.ts              # Aggregate quantitative usage metrics
│   └── section.ts            # Generic section analyzer (facets + keywords + thresholds)
└── reporters/
    └── report.ts             # Render reports (text, JSON, Markdown)

templates/
└── eval-standard.json        # Default OneAD evaluation standard (source of truth)

tests/
├── cli.test.ts               # CLI regression tests (subprocess)
├── section.test.ts           # Section analyzer unit tests
├── standard.test.ts          # Standard loader/validator tests
├── data-quality.test.ts      # Data quality checker tests
└── fixtures/                 # Test fixture files
```

### Pipeline / 處理流程

```
Extract --> Analyze --> Score --> Report

1. Extract:  Read session-meta, facets, SQLite, JSONL from local stores
2. Analyze:  Aggregate usage + run each section through generic analyzer
3. Score:    Compare metrics against section thresholds
4. Report:   Render in chosen format with evidence and recommendations
```

---

## Development / 開發

### Scripts / 腳本

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run CLI directly via tsx (no build needed)
npm run test         # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
```

### Running tests / 執行測試

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/section.test.ts

# Watch mode
npm run test:watch
```

### Project conventions / 專案慣例

- All progress/status messages are written to **stderr**; report output goes to **stdout**
- JSON output (`--format json`) is guaranteed clean on stdout for piping
- SQLite connections are wrapped in `try/finally` to prevent resource leaks
- The evaluation standard template (`templates/eval-standard.json`) is the single source of truth
- Custom standards inherit default `noiseFilters` if not specified

---

## Troubleshooting / 問題排除

### No sessions found

- Verify `~/.claude/usage-data/session-meta/` contains JSON files
- Check the date range matches when the AI tools were used
- For Codex, verify `~/.codex/state_5.sqlite` exists

### Empty facets

- Facets are generated asynchronously by Claude Code after sessions end
- Recent sessions may not have facets yet
- The tool will show a data quality warning in this case

### JSON output contains extra text

This was fixed in v0.1.0. All progress messages now go to stderr. If you encounter this, ensure you are using the latest version. Use `2>/dev/null` to suppress stderr when piping:

```bash
npx tsx src/cli.ts report --format json 2>/dev/null | jq .
```

---

## License

MIT
