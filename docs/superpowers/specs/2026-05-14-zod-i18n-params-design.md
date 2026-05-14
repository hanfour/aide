# Zod i18n — Runtime-Interpolated Message Params (PR C)

**Date:** 2026-05-14
**Status:** Approved, ready for implementation
**Predecessors:** [`2026-05-13-zod-i18n-design.md`](./2026-05-13-zod-i18n-design.md) (PR A #135 + PR B #136)
**Scope:** apps/web (1 callsite) + apps/api (3 callsites) + packages/i18n-validation (translate.ts capability) + 5 locale catalogues (3 new keys) + audit script extension

## Problem

PR B (#136) swept 16 inline literal Zod messages into `validation.custom.*` keys, but deliberately deferred all callsites whose message string contains runtime interpolation (template literal with `${...}`). A grep sweep for `message:\s*\`` across `apps/{api,web}/src` finds **4 such callsites**:

| # | File | Line | Surface | Shape |
|---|---|---|---|---|
| 1 | `apps/web/src/components/evaluator/RubricEditor.tsx` | 58 | client form (`useTranslatedZodResolver`) | `ctx.addIssue({ message: \`Invalid rubric definition: ${result.error.issues.map(...).join("; ")}\` })` |
| 2 | `apps/api/src/trpc/routers/rubrics.ts` | 104 | server tRPC throw (`errorFormatter`) | `throw new TRPCError({ message: \`Invalid rubric definition: ${parsed.error.message}\` })` |
| 3 | `apps/api/src/trpc/routers/rubrics.ts` | 174 | server tRPC throw | same as #2 (update path) |
| 4 | `apps/api/src/trpc/routers/accountGroups.ts` | 372 | server tRPC throw | `\`account platform "${account.platform}" does not match group platform "${group.platform}"\`` |

The existing i18n tool-chain (`packages/i18n-validation`, `useTranslatedZodResolver`, tRPC `errorFormatter`) handles static `validation.*` keys only. The boundaries lose param payloads:

- `ZodIssue.params` is dropped by `zodResolver` mapping to react-hook-form `FieldError = {type, message, ref}`.
- `ZodError.flatten()` (used in tRPC `errorFormatter`) returns only message strings.

## Goals

1. Localize all 4 callsites to render runtime-interpolated translations across 5 locales (en, zh-TW, zh-CN, ja, ko).
2. Add the new capability **without** modifying any existing boundary translator (`errorMap.ts`, `useTranslatedZodResolver.ts`, `apps/api/src/server.ts` errorFormatter). All paths in PR A/B remain intact.
3. Make the param-passing scheme boundary-agnostic (works through RHF `FieldError`, `ZodError.flatten()`, and tRPC wire) so future callsites can adopt it without per-boundary plumbing.

## Non-goals

- Refactoring `lookup()` in `errorMap.ts` to share code with `translateValidationKey()` (loud-vs-quiet behaviour is intentionally distinct, documented in PR B).
- Sweeping plain-string callsites that lack params (e.g. `accountGroups.ts:362-365 "account does not belong to this group's org"`). PR B-shaped sweep.
- Adding the audit script to CI (cost/benefit not yet justified).
- Native-speaker translation review (tracked separately as #134; this PR appends the 3 new keys to that backlog).

## Approach

### Chosen: Inline hash-suffix encoding

Encode params into the message string itself via a `#`-separated URL-encoded JSON payload. The schema author calls a constructor `formatValidationKey(key, params)`; the boundary decoder `translateValidationKey(messages, raw)` splits on `#`, looks up the key, substitutes `{placeholder}`s from the decoded params.

**Wire format:**
```
<key><SEP><payload>
```
- `<key>` — `validation.`-prefixed dot-path string (unchanged from PR A/B)
- `<SEP>` — literal `#` (U+0023)
- `<payload>` — `encodeURIComponent(JSON.stringify(params))` where `params: Record<string, string | number>`

**Example end-to-end:**
```ts
// schema
ctx.addIssue({
  message: formatValidationKey(
    "validation.custom.evaluator.rubricInvalidDefinition",
    { detail: "Must be valid JSON" },
  ),
});
// wire form (after schema run): "validation.custom.evaluator.rubricInvalidDefinition#%7B%22detail%22%3A%22Must%20be%20valid%20JSON%22%7D"
// boundary translates to zh-TW: "無效的 rubric 定義：必須為有效的 JSON"
```

### Approaches considered and rejected

**B — `issue.params` route with zodResolver/errorFormatter fork.** Forks `@hookform/resolvers/zod` and changes the tRPC error shape to preserve `ZodIssue.params`. Rejected: violates the "add new capability only" constraint; large blast radius; breaks tRPC `formatError` type signature.

**C — Eager render at schema construction time.** Schema becomes a factory that receives `t()`; addIssue calls `t("validation.x.y", {detail})` directly. Rejected: invades schema layer with i18n concern; requires reworking PR B's static-key pattern across all 7 form files; pushes the schema layer into the i18n runtime ALS dependency.

## Components

```
packages/i18n-validation/src/
├── translate.ts          # MODIFY: add formatValidationKey, params-aware translateValidationKey
├── (errorMap.ts)         # UNCHANGED
└── (everything else)     # UNCHANGED

packages/i18n-validation/messages/{en,zh-TW,zh-CN,ja,ko}.json
└── validation.custom.{evaluator,accountGroups}                 # ADD 3 keys

apps/web/src/components/evaluator/RubricEditor.tsx              # MIGRATE 1 callsite
apps/api/src/trpc/routers/rubrics.ts                            # MIGRATE 2 callsites
apps/api/src/trpc/routers/accountGroups.ts                      # MIGRATE 1 callsite

scripts/audit-zod-i18n.mjs                                      # EXTEND: detect template-literal message
packages/i18n-validation/tests/translate.test.ts                # ADD ~6 params cases
apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx       # ADD hook-level integration test
```

### `packages/i18n-validation/src/translate.ts`

Exports two functions:

```ts
export function formatValidationKey(
  key: string,
  params?: Record<string, string | number>,
): string {
  if (!params || Object.keys(params).length === 0) return key;
  return `${key}#${encodeURIComponent(JSON.stringify(params))}`;
}

export function translateValidationKey(
  messages: ValidationMessages,
  raw: string,
): string {
  if (!raw.startsWith("validation.")) return raw;
  const hashIdx = raw.indexOf("#");
  const keyPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const paramsPart = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null;

  const parts = keyPart.split(".");
  let cursor: unknown = messages;
  for (const p of parts) {
    if (cursor !== null && typeof cursor === "object" && p in cursor) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return raw;
    }
  }
  if (typeof cursor !== "string") return raw;
  const template = cursor;

  if (paramsPart === null) return template;

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(decodeURIComponent(paramsPart));
  } catch {
    return template;
  }
  let out = template;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}
```

Public export added to `packages/i18n-validation/src/index.ts`:
```ts
export { formatValidationKey, translateValidationKey } from "./translate.js";
```

### Edge case contract

| Input | Output |
|---|---|
| `raw` without `validation.` prefix | returned verbatim (unchanged from PR B) |
| `raw` with `#` but `keyPart` misses catalogue | returns `raw` (full, including `#suffix`) |
| `raw` with `#` but path resolves to non-string leaf | returns `raw` |
| `raw` with `#` but `paramsPart` is malformed JSON | returns bare template (placeholders unresolved) |
| Template has `{foo}` but params omit `foo` | `{foo}` literal stays in output |
| Params has `{bar}` but template omits `bar` | silently ignored |
| Params value contains `#` | safe — `encodeURIComponent` encodes `#` as `%23`; split point is the first literal `#` |
| Existing (PR A/B) 16 callsites — no `#` in message | identical behaviour to PR B — second branch (`paramsPart === null`) returns template directly |

### Catalogue additions

```jsonc
{
  "validation": {
    "custom": {
      "evaluator": {
        // existing keys unchanged ...
        "rubricInvalidDefinition": "Invalid rubric definition: {detail}"
      },
      "accountGroups": {
        "accountOrgMismatch": "Account does not belong to this group's org",
        "accountPlatformMismatch": "Account platform \"{accountPlatform}\" does not match group platform \"{groupPlatform}\""
      }
    }
  }
}
```

Note: `accountOrgMismatch` is added to all 5 locales but **no callsite migrates to it in PR C**. It is groundwork for a future plain-string sweep PR.

### 5-locale translations

| key | en | zh-TW | zh-CN | ja | ko |
|---|---|---|---|---|---|
| `evaluator.rubricInvalidDefinition` | `Invalid rubric definition: {detail}` | `無效的 rubric 定義：{detail}` | `无效的评分标准定义：{detail}` | `ルーブリック定義が無効です：{detail}` | `루브릭 정의가 잘못되었습니다: {detail}` |
| `accountGroups.accountOrgMismatch` | `Account does not belong to this group's org` | `帳號不屬於此群組所在的組織` | `账号不属于此群组所在的组织` | `アカウントはこのグループの組織に属していません` | `계정이 이 그룹의 조직에 속하지 않습니다` |
| `accountGroups.accountPlatformMismatch` | `Account platform "{accountPlatform}" does not match group platform "{groupPlatform}"` | `帳號平台「{accountPlatform}」與群組平台「{groupPlatform}」不一致` | `账号平台“{accountPlatform}”与群组平台“{groupPlatform}”不一致` | `アカウントのプラットフォーム「{accountPlatform}」はグループのプラットフォーム「{groupPlatform}」と一致しません` | `계정 플랫폼 "{accountPlatform}"이(가) 그룹 플랫폼 "{groupPlatform}"과(와) 일치하지 않습니다` |

Translation decisions:
- "rubric": zh-TW keeps the English word (mirrors `rubricMustBeValidJson` zh-TW which translates only "JSON"-adjacent text). zh-CN uses "评分标准" (matching the broader zh-CN tone in existing keys).
- "platform": East-Asian locales use the standard loan (平台 / プラットフォーム / 플랫폼).
- `{detail}` content comes from Zod's own errorMap (already runtime-localized via PR #135 `errorMap` + ALS), so composed output reads naturally in any locale.

Quality: LLM first-pass, consistent with the existing `validation.custom.*` keys. Added to issue #134 native-speaker review backlog at merge time.

### Callsite migrations

Each callsite adds `import { formatValidationKey } from "@caliber/i18n-validation";` and rewrites the `message:` to `formatValidationKey(key, params)`.

**`apps/web/src/components/evaluator/RubricEditor.tsx:56-60`:**
```ts
ctx.addIssue({
  code: z.ZodIssueCode.custom,
  message: formatValidationKey(
    "validation.custom.evaluator.rubricInvalidDefinition",
    { detail: result.error.issues.map((i) => i.message).join("; ") },
  ),
});
```

**`apps/api/src/trpc/routers/rubrics.ts:102-105` and `172-175`** (same shape, create + update paths):
```ts
throw new TRPCError({
  code: "BAD_REQUEST",
  message: formatValidationKey(
    "validation.custom.evaluator.rubricInvalidDefinition",
    { detail: parsed.error.message },
  ),
});
```

**`apps/api/src/trpc/routers/accountGroups.ts:369-374`:**
```ts
throw new TRPCError({
  code: "BAD_REQUEST",
  message: formatValidationKey(
    "validation.custom.accountGroups.accountPlatformMismatch",
    {
      accountPlatform: account.platform,
      groupPlatform: group.platform,
    },
  ),
});
```

### Audit script extension

`scripts/audit-zod-i18n.mjs` gains a new pattern variant:

```js
{
  kind: "template",
  re: /message:\s*`([^`]+)`/g,
  msgGroup: 1,
}
```

Detects backtick template literals in `message:` fields across both `addIssue` and `TRPCError` contexts. Reports them under `kind=template` in the TSV output. After PR C merges, `awk -F'\t' '$3=="template"' /tmp/zod-i18n-audit.tsv` should produce 0 lines.

Not extending `inline2` / `opts` / `refine` regexes to accept backticks — those positions historically don't see template literals (YAGNI).

## Boundary flow

**Client (RubricEditor):**
```
schema.superRefine
  → ctx.addIssue({ message: formatValidationKey(key, {detail}) })
  → ZodError → zodResolver → RHF FieldError.message = "validation...#%7B..."
  → useTranslatedZodResolver translateNode
  → translateValidationKey(messages, raw) decodes # → lookup + substitute
  → form input shows localized message
```

**Server (rubrics, accountGroups):**
```
throw new TRPCError({ message: formatValidationKey(key, params) })
  → tRPC serialization
  → errorFormatter on shape.message: translateValidationKey(messages, shape.message)
  → wire response carrying translated string
  → client tRPC client unwrap → toast / UI
```

The existing PR B errorFormatter (`apps/api/src/server.ts:194`) already runs `translateValidationKey` over `shape.message` — picking up the params-aware translation requires no errorFormatter changes.

## Testing

### Unit (`packages/i18n-validation/tests/translate.test.ts`, +6 cases)

1. `formatValidationKey` returns bare key when params absent.
2. `formatValidationKey` returns bare key when params is `{}`.
3. `formatValidationKey` encodes params as URL-encoded JSON suffix.
4. `translateValidationKey` decodes params and substitutes `{detail}` (en).
5. `translateValidationKey` roundtrip across zh-TW with real catalogue entry.
6. `translateValidationKey` substitutes multiple placeholders (`{accountPlatform}` + `{groupPlatform}`).
7. `translateValidationKey` falls back to bare template on malformed payload (placeholders unresolved).
8. `translateValidationKey` returns full raw input when keyPart misses catalogue.

### Integration (`apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx`)

One new case alongside the existing zh-TW/en cases. The file mounts a real `useForm` + `NextIntlClientProvider` via the `Probe` helper already present in the file (`apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx:1-30`).

- Mount with zh-TW locale
- Build a schema with `.superRefine` that emits a `formatValidationKey("validation.custom.evaluator.rubricInvalidDefinition", { detail: "X" })` issue
- Submit invalid input, assert resulting `FieldError.message` is `"無效的 rubric 定義：X"`

### Existing test suites (must remain green)

- 46 i18n unit tests (`packages/i18n-validation/tests/`)
- 22 web tests (`apps/web/src/lib/i18n/*.test.*`)
- 254 api integ tests (`apps/api/tests/`)

The "no `#` in raw" path in `translateValidationKey` is unchanged in behaviour — all PR A/B callsites stay byte-identical in output.

### Audit verification (manual, not unit-tested)

Pre/post comparison run during PR review:
```sh
# on main: expect ≥4 template hits
node scripts/audit-zod-i18n.mjs | awk -F'\t' '$3=="template"' | wc -l

# on PR branch: expect 0
node scripts/audit-zod-i18n.mjs | awk -F'\t' '$3=="template"' | wc -l
```
Counts recorded in PR body Verification section.

### Live verification (per `working_preferences`)

After CI green:
1. Local docker build: api + web → bump `docker/.env` `VERSION` → restart containers
2. From mac-mini at zh-TW locale: open evaluator → RubricEditor → paste invalid JSON → confirm translated message renders (not raw `validation.custom...#...`)
3. From mac-mini: trigger accountGroups platform-mismatch path (via existing admin flow) → confirm translated TRPCError message in toast

## Risks and rollback

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A 5th template-literal callsite missed | Low | User sees raw encoded key | audit extension yields 0 on PR branch + manual `grep -rEn 'message:\s*\`'` cross-check |
| Future i18n key contains `#` | Very low | Translate splits at wrong point | Convention documented in `translate.ts`; parity-test extension optional (not blocking PR C) |
| `parsed.error.message` contains a literal `{detail}` substring | Very low | Placeholder mis-substituted | `replaceAll` runs once per key — no recursion. Safe by inspection. |
| 5-locale JSON typo breaks parity test | Medium | Test red | Apply catalogue changes via single Node script, not manual 5-file edit. |
| `parsed.error.message` is verbose ZodError stack | Low | Long detail line in UI | Out of scope — preserves PR B's behaviour. Refinement deferred. |
| Existing 322 tests regress | Very low | CI red | "No `#`" code path unchanged. Run full suite before opening PR. |

**Rollback:** the PR is a single linear commit chain on a feature branch. `git revert` of the merge commit fully reverses the change. Catalogue keys left behind are harmless dead keys; `formatValidationKey` export becomes dead capability — both included in the revert.

## Scope guard (explicitly excluded)

1. Not merging `lookup()` (errorMap.ts) with `translateValidationKey()` — intentionally separate per PR B documentation.
2. Not modifying `useTranslatedZodResolver.ts` (capability lives inside `translateValidationKey`; consumer unchanged).
3. Not modifying `apps/api/src/server.ts` errorFormatter.
4. Not migrating `accountGroups.ts:362-365` plain-string callsite (no params; not the PR C shape).
5. Not extending `inline2` / `opts` / `refine` audit regexes for backticks.
6. Not adding `audit-zod-i18n.mjs` to CI.

## Acceptance criteria

1. `RubricEditor.tsx:58` error message renders translated text in zh-TW, ja, zh-CN, ko (and en literal) when invalid rubric JSON is submitted.
2. `rubrics.ts` create/update mutations return localized `BAD_REQUEST` message when definition fails validation, surfacing via existing tRPC errorFormatter path.
3. `accountGroups.ts` platform-mismatch throw returns localized message with both platform names interpolated.
4. ≥ 6 new unit tests + 1 hook-level integration test, all green.
5. Existing 46 + 22 + 254 tests remain green.
6. Audit script on PR branch reports 0 `kind=template` hits.
7. Issue #134 (native-speaker review backlog) updated with the 3 new keys.
8. PR merged with no follow-up issue filed (this is the closeout PR for the Zod-i18n series).
