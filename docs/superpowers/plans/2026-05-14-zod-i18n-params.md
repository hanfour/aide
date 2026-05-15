# Zod i18n Params (PR C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the Zod-i18n series by localizing the 4 remaining template-literal validation messages (`RubricEditor.tsx:58`, `rubrics.ts:104`, `rubrics.ts:174`, `accountGroups.ts:372`) across en/zh-TW/zh-CN/ja/ko.

**Architecture:** Add a `formatValidationKey(key, params)` constructor and extend `translateValidationKey(messages, raw)` to decode a `#`-separated URL-encoded JSON suffix carrying runtime params. Boundary translators (`useTranslatedZodResolver` on client, tRPC `errorFormatter` on server) consume the new format with **zero changes** — the capability is added entirely inside `packages/i18n-validation/src/translate.ts`. 3 new keys are added to all 5 locale catalogues (parity-test enforced). 4 callsites migrate to call `formatValidationKey(...)` instead of building template literals.

**Tech Stack:** TypeScript, Zod 3.x, vitest, react-hook-form + `@hookform/resolvers/zod`, tRPC, next-intl, pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-05-14-zod-i18n-params-design.md`](../specs/2026-05-14-zod-i18n-params-design.md)

**Branch:** `feature/zod-i18n-params` (already created, contains spec commit `9a6bb2b`)

---

## Task 1: TDD `formatValidationKey` constructor

**Files:**
- Modify: `packages/i18n-validation/tests/translate.test.ts`
- Modify: `packages/i18n-validation/src/translate.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/i18n-validation/tests/translate.test.ts`:

```typescript
import { formatValidationKey } from "../src/translate.js";

describe("formatValidationKey", () => {
  it("returns the bare key when params are absent", () => {
    expect(formatValidationKey("validation.custom.x.y")).toBe(
      "validation.custom.x.y",
    );
  });

  it("returns the bare key when params is an empty object", () => {
    expect(formatValidationKey("validation.custom.x.y", {})).toBe(
      "validation.custom.x.y",
    );
  });

  it("encodes params as a URL-encoded JSON suffix after '#'", () => {
    const out = formatValidationKey("validation.custom.x.y", { detail: "foo" });
    expect(out.startsWith("validation.custom.x.y#")).toBe(true);
    expect(decodeURIComponent(out.split("#")[1] ?? "")).toBe(
      '{"detail":"foo"}',
    );
  });

  it("preserves order and supports multiple params", () => {
    const out = formatValidationKey("validation.custom.x.y", {
      accountPlatform: "anthropic",
      groupPlatform: "openai",
    });
    expect(decodeURIComponent(out.split("#")[1] ?? "")).toBe(
      '{"accountPlatform":"anthropic","groupPlatform":"openai"}',
    );
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm --filter @caliber/i18n-validation test -- translate`
Expected: 4 new tests FAIL with `formatValidationKey is not a function` (the import resolves to undefined at runtime because no export exists yet).

- [ ] **Step 3: Implement `formatValidationKey`**

Modify `packages/i18n-validation/src/translate.ts` — add ABOVE the existing `translateValidationKey` export:

```typescript
/**
 * Build a wire-form validation message that carries runtime `{name}`
 * substitution params alongside a `validation.*` key. The result is a
 * single string of shape `<key>#<urlencoded-json>` that survives every
 * boundary (react-hook-form `FieldError.message`, `ZodError.flatten()`,
 * tRPC wire) intact. `translateValidationKey()` decodes it at the
 * rendering boundary.
 *
 * No params (or `{}`) returns the bare key — keeps the wire form clean
 * for the common static-key case.
 */
export function formatValidationKey(
  key: string,
  params?: Record<string, string | number>,
): string {
  if (!params || Object.keys(params).length === 0) return key;
  return `${key}#${encodeURIComponent(JSON.stringify(params))}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @caliber/i18n-validation test -- translate`
Expected: All translate.test.ts cases PASS (existing 5 + new 4 = 9 total).

- [ ] **Step 5: Commit**

```bash
git add packages/i18n-validation/src/translate.ts \
        packages/i18n-validation/tests/translate.test.ts
git commit -m "feat(i18n): formatValidationKey constructor for runtime params"
```

---

## Task 2: TDD params-aware `translateValidationKey`

**Files:**
- Modify: `packages/i18n-validation/tests/translate.test.ts`
- Modify: `packages/i18n-validation/src/translate.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/i18n-validation/tests/translate.test.ts` (after the `formatValidationKey` describe block):

```typescript
describe("translateValidationKey with params", () => {
  it("decodes params and substitutes {detail} (en)", async () => {
    const messages = await loadValidationMessages("en");
    const raw = formatValidationKey(
      "validation.custom.evaluator.rubricInvalidDefinition",
      { detail: "oops" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      "Invalid rubric definition: oops",
    );
  });

  it("roundtrips through zh-TW", async () => {
    const messages = await loadValidationMessages("zh-TW");
    const raw = formatValidationKey(
      "validation.custom.evaluator.rubricInvalidDefinition",
      { detail: "必須為有效的 JSON" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      "無效的 rubric 定義：必須為有效的 JSON",
    );
  });

  it("substitutes multiple placeholders", async () => {
    const messages = await loadValidationMessages("en");
    const raw = formatValidationKey(
      "validation.custom.accountGroups.accountPlatformMismatch",
      { accountPlatform: "anthropic", groupPlatform: "openai" },
    );
    expect(translateValidationKey(messages, raw)).toBe(
      'Account platform "anthropic" does not match group platform "openai"',
    );
  });

  it("falls back to bare template when payload JSON is malformed", async () => {
    const messages = await loadValidationMessages("en");
    expect(
      translateValidationKey(
        messages,
        "validation.custom.evaluator.rubricInvalidDefinition#not-json",
      ),
    ).toBe("Invalid rubric definition: {detail}");
  });

  it("returns the full raw input when keyPart misses the catalogue", async () => {
    const messages = await loadValidationMessages("en");
    const raw =
      "validation.custom.does.not.exist#" +
      encodeURIComponent(JSON.stringify({ x: 1 }));
    expect(translateValidationKey(messages, raw)).toBe(raw);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm --filter @caliber/i18n-validation test -- translate`
Expected: 5 new tests FAIL — first 3 fail because the catalogue doesn't have the new keys yet (returns raw input from miss path); test 4 fails because current `translateValidationKey` returns the raw input on a key with `#`; test 5 fails for the same reason.

> Note: tests 1–3 will PASS once Task 4 adds catalogue keys, but should FAIL right now from the missing-key path. The point of running here is to confirm the test wiring works.

- [ ] **Step 3: Extend `translateValidationKey` to handle the `#` payload**

In `packages/i18n-validation/src/translate.ts`, REPLACE the existing `translateValidationKey` function with:

```typescript
/**
 * Resolve a `validation.*`-prefixed key against the loaded catalogue.
 * Returns the input verbatim if it isn't a key, the catalogue path doesn't
 * resolve, or the resolved value isn't a string. Quiet (no warn) — call
 * sites that care about misses do their own logging.
 *
 * Mirrors the `lookup()` helper in `errorMap.ts` but kept separate because
 * this is the boundary-translation path: when a Zod schema supplies an
 * explicit `message` to `.min(N, key)` / `.refine(..., {message: key})`,
 * `makeIssue()` bypasses the global errorMap and the raw key surfaces.
 * Client (react-hook-form resolver) and server (tRPC errorFormatter) both
 * use this helper to translate at the rendering boundary.
 *
 * If `raw` has the shape `<key>#<urlencoded-json>` (produced by
 * `formatValidationKey()`), the payload is decoded and `{name}`
 * placeholders in the resolved template are substituted from it.
 *
 * Loud-vs-quiet contract vs `lookup()`: `lookup()` (inside errorMap) WARNS
 * on miss because it runs during schema authoring time when a missing key
 * is almost certainly a developer bug worth surfacing. This helper runs at
 * the rendering boundary AFTER the schema has already accepted the key, so
 * a miss here is a deployment skew (catalogue lagging behind code) — we
 * pass through silently rather than spam every form-submit with warnings.
 */
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

- [ ] **Step 4: Run tests 4 and 5 to verify the GREEN cases now pass**

Run: `pnpm --filter @caliber/i18n-validation test -- translate`
Expected:
- Existing 5 cases: PASS
- New `formatValidationKey` 4 cases: PASS
- New `translateValidationKey with params` cases 4 (malformed payload) and 5 (catalogue miss): PASS
- Cases 1, 2, 3 (which need catalogue keys): still FAIL with raw-key output — this is correct; Task 4 finishes them.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n-validation/src/translate.ts \
        packages/i18n-validation/tests/translate.test.ts
git commit -m "feat(i18n): translateValidationKey decodes #-encoded params"
```

---

## Task 3: Export `formatValidationKey` from the package barrel

**Files:**
- Modify: `packages/i18n-validation/src/index.ts`

- [ ] **Step 1: Add the export**

Replace this line in `packages/i18n-validation/src/index.ts`:

```typescript
export { translateValidationKey } from "./translate.js";
```

with:

```typescript
export { formatValidationKey, translateValidationKey } from "./translate.js";
```

- [ ] **Step 2: Build the package**

Run: `pnpm --filter @caliber/i18n-validation build`
Expected: tsc completes with 0 errors. `dist/index.js` now re-exports both functions.

- [ ] **Step 3: Typecheck the workspace**

Run: `pnpm -r typecheck`
Expected: 0 errors across all packages and apps.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n-validation/src/index.ts
git commit -m "feat(i18n): export formatValidationKey from package barrel"
```

---

## Task 4: Add 3 catalogue keys × 5 locales

**Files:**
- Modify: `packages/i18n-validation/messages/en.json`
- Modify: `packages/i18n-validation/messages/zh-TW.json`
- Modify: `packages/i18n-validation/messages/zh-CN.json`
- Modify: `packages/i18n-validation/messages/ja.json`
- Modify: `packages/i18n-validation/messages/ko.json`

- [ ] **Step 1: Add 3 keys to `en.json`**

In `packages/i18n-validation/messages/en.json`, inside `validation.custom`:

Add to the existing `evaluator` object (after `chooseFacetModel`):
```json
"rubricInvalidDefinition": "Invalid rubric definition: {detail}"
```

Add a new `accountGroups` sibling object alongside `accounts`:
```json
"accountGroups": {
  "accountOrgMismatch": "Account does not belong to this group's org",
  "accountPlatformMismatch": "Account platform \"{accountPlatform}\" does not match group platform \"{groupPlatform}\""
}
```

Final relevant excerpt of `en.json`:
```json
"evaluator": {
  "versionRequired": "Version is required",
  "definitionRequired": "Definition is required",
  "rubricMustBeValidJson": "Must be valid JSON",
  "facetExtractionRequiresLlm": "Facet extraction requires LLM evaluation to be enabled first",
  "chooseFacetModel": "Choose a facet model",
  "rubricInvalidDefinition": "Invalid rubric definition: {detail}"
},
"accounts": { ... unchanged ... },
"accountGroups": {
  "accountOrgMismatch": "Account does not belong to this group's org",
  "accountPlatformMismatch": "Account platform \"{accountPlatform}\" does not match group platform \"{groupPlatform}\""
}
```

- [ ] **Step 2: Add the same 3 keys to `zh-TW.json`**

Add to `validation.custom.evaluator`:
```json
"rubricInvalidDefinition": "無效的 rubric 定義：{detail}"
```

Add new `validation.custom.accountGroups` sibling:
```json
"accountGroups": {
  "accountOrgMismatch": "帳號不屬於此群組所在的組織",
  "accountPlatformMismatch": "帳號平台「{accountPlatform}」與群組平台「{groupPlatform}」不一致"
}
```

- [ ] **Step 3: Add the same 3 keys to `zh-CN.json`**

Add to `validation.custom.evaluator`:
```json
"rubricInvalidDefinition": "无效的评分标准定义：{detail}"
```

Add new `validation.custom.accountGroups` sibling:
```json
"accountGroups": {
  "accountOrgMismatch": "账号不属于此群组所在的组织",
  "accountPlatformMismatch": "账号平台“{accountPlatform}”与群组平台“{groupPlatform}”不一致"
}
```

- [ ] **Step 4: Add the same 3 keys to `ja.json`**

Add to `validation.custom.evaluator`:
```json
"rubricInvalidDefinition": "ルーブリック定義が無効です：{detail}"
```

Add new `validation.custom.accountGroups` sibling:
```json
"accountGroups": {
  "accountOrgMismatch": "アカウントはこのグループの組織に属していません",
  "accountPlatformMismatch": "アカウントのプラットフォーム「{accountPlatform}」はグループのプラットフォーム「{groupPlatform}」と一致しません"
}
```

- [ ] **Step 5: Add the same 3 keys to `ko.json`**

Add to `validation.custom.evaluator`:
```json
"rubricInvalidDefinition": "루브릭 정의가 잘못되었습니다: {detail}"
```

Add new `validation.custom.accountGroups` sibling:
```json
"accountGroups": {
  "accountOrgMismatch": "계정이 이 그룹의 조직에 속하지 않습니다",
  "accountPlatformMismatch": "계정 플랫폼 \"{accountPlatform}\"이(가) 그룹 플랫폼 \"{groupPlatform}\"과(와) 일치하지 않습니다"
}
```

- [ ] **Step 6: Run the full i18n-validation test suite**

Run: `pnpm --filter @caliber/i18n-validation test`
Expected:
- `parity.test.ts` PASSES (all 5 locales have the same leaf set as en).
- `translate.test.ts` cases that needed catalogue keys (`Task 2` cases 1–3, the `en` / `zh-TW` / `multi-placeholder` roundtrips) now PASS.
- All other tests (messages, errorMap, runtime, locales) remain GREEN.
- Whole suite: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n-validation/messages/*.json
git commit -m "feat(i18n): add rubricInvalidDefinition + accountGroups keys across 5 locales"
```

---

## Task 5: Migrate `RubricEditor.tsx` + add hook-level integration test

**Files:**
- Modify: `apps/web/src/components/evaluator/RubricEditor.tsx`
- Modify: `apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx`

- [ ] **Step 1: Write the failing integration test**

Append to `apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx`, after the existing `describe("useTranslatedZodResolver", ...)` block — add a sibling `describe` block (this keeps the existing `schema` const isolated to the original describe and uses its own params-bearing schema):

```typescript
import { formatValidationKey } from "@caliber/i18n-validation";

// Schema that mirrors the RubricEditor.tsx:58 superRefine shape — emits a
// custom issue whose message carries a runtime-interpolated `{detail}`.
const rubricSchema = z.object({
  definitionJson: z.string().superRefine((_val, ctx) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: formatValidationKey(
        "validation.custom.evaluator.rubricInvalidDefinition",
        { detail: "必須為有效的 JSON" },
      ),
    });
  }),
});
type RubricValues = z.infer<typeof rubricSchema>;

interface RubricProbeProps {
  onError: (msg: string | undefined) => void;
  onSubmitRef: { current: (() => void) | null };
}

function RubricProbe({ onError, onSubmitRef }: RubricProbeProps) {
  const resolver = useTranslatedZodResolver(rubricSchema);
  const { handleSubmit } = useForm<RubricValues>({
    resolver,
    defaultValues: { definitionJson: "" },
  });
  const submit = useRef<() => void>(() => undefined);
  submit.current = () => {
    void handleSubmit(
      () => undefined,
      (errs) => {
        onError(errs.definitionJson?.message as string | undefined);
      },
    )();
  };
  useEffect(() => {
    onSubmitRef.current = () => submit.current?.();
  }, [onSubmitRef]);
  return <span data-testid="rubric-ready">1</span>;
}

describe("useTranslatedZodResolver with runtime params", () => {
  it("translates a key carrying {detail} into zh-TW with interpolation", async () => {
    await loadValidationMessages("zh-TW");
    let captured: string | undefined;
    const onSubmitRef: { current: (() => void) | null } = { current: null };
    render(
      <NextIntlClientProvider
        locale="zh-TW"
        messages={zhTWMessages as Record<string, unknown>}
      >
        <RubricProbe
          onError={(m) => {
            captured = m;
          }}
          onSubmitRef={onSubmitRef}
        />
      </NextIntlClientProvider>,
    );
    await pollUntilTranslated(
      () => captured,
      onSubmitRef,
      "無效的 rubric 定義：必須為有效的 JSON",
    );
  });
});
```

- [ ] **Step 2: Run the new test to verify it passes**

Run: `pnpm --filter @caliber/web test -- useTranslatedZodResolver`
Expected: new test PASSES on first run. The capability (Task 2's params-aware `translateValidationKey`) and the catalogue (Task 4's zh-TW `rubricInvalidDefinition` entry) are already in place, so the integration test is a regression guard for the assembled pipeline rather than a TDD driver. If it FAILS, the most likely cause is a syntax error in the zh-TW JSON from Task 4 — re-check `packages/i18n-validation/messages/zh-TW.json`.

- [ ] **Step 3: Migrate `RubricEditor.tsx:48-60`**

In `apps/web/src/components/evaluator/RubricEditor.tsx`, add the import (alongside the existing `useTranslatedZodResolver` import on line 5):

```typescript
import { formatValidationKey } from "@caliber/i18n-validation";
```

Then replace lines 56-60:

```typescript
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid rubric definition: ${result.error.issues.map((i) => i.message).join("; ")}`,
        });
```

with:

```typescript
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: formatValidationKey(
            "validation.custom.evaluator.rubricInvalidDefinition",
            { detail: result.error.issues.map((i) => i.message).join("; ") },
          ),
        });
```

- [ ] **Step 4: Run the apps/web test suite**

Run: `pnpm --filter @caliber/web test`
Expected: All previous tests + the new integration test PASS. No regressions.

- [ ] **Step 5: Typecheck apps/web**

Run: `pnpm --filter @caliber/web typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/evaluator/RubricEditor.tsx \
        apps/web/tests/lib/i18n/useTranslatedZodResolver.test.tsx
git commit -m "feat(web): translate RubricEditor invalid-definition message via formatValidationKey"
```

---

## Task 6: Migrate `rubrics.ts` router throws (2 callsites)

**Files:**
- Modify: `apps/api/src/trpc/routers/rubrics.ts`

- [ ] **Step 1: Add the import**

Inspect the existing imports at the top of `apps/api/src/trpc/routers/rubrics.ts`. Add to the existing `@caliber/i18n-validation` import line if one exists, OR add a new line:

```typescript
import { formatValidationKey } from "@caliber/i18n-validation";
```

(If `@caliber/i18n-validation` is not yet imported in this file, the new line is the addition.)

- [ ] **Step 2: Migrate the create-path throw (`rubrics.ts:102-105`)**

Replace:
```typescript
      const parsed = rubricSchema.safeParse(input.definition);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid rubric definition: ${parsed.error.message}`,
        });
      }
```

with:
```typescript
      const parsed = rubricSchema.safeParse(input.definition);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: formatValidationKey(
            "validation.custom.evaluator.rubricInvalidDefinition",
            { detail: parsed.error.message },
          ),
        });
      }
```

- [ ] **Step 3: Migrate the update-path throw (`rubrics.ts:172-175`)**

Replace:
```typescript
      if (input.patch.definition !== undefined) {
        const parsed = rubricSchema.safeParse(input.patch.definition);
        if (!parsed.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid rubric definition: ${parsed.error.message}`,
          });
        }
        updates.definition = parsed.data as Record<string, unknown>;
      }
```

with:
```typescript
      if (input.patch.definition !== undefined) {
        const parsed = rubricSchema.safeParse(input.patch.definition);
        if (!parsed.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: formatValidationKey(
              "validation.custom.evaluator.rubricInvalidDefinition",
              { detail: parsed.error.message },
            ),
          });
        }
        updates.definition = parsed.data as Record<string, unknown>;
      }
```

- [ ] **Step 4: Run apps/api tests**

Run: `pnpm --filter @caliber/api test`
Expected: All existing api tests PASS. Some tests may currently assert on the literal `"Invalid rubric definition: ..."` string — search for that string:
```bash
grep -rn 'Invalid rubric definition' apps/api/tests/ 2>/dev/null || echo "no test assertions on literal string"
```
If found, the assertion must be updated to expect the new wire form `validation.custom.evaluator.rubricInvalidDefinition#<urlencoded>` (the test runs without the api server.ts errorFormatter in scope, so it sees the raw thrown message).

Actually, tests invoking the full server via supertest WILL see the translated message because errorFormatter runs. Tests invoking the router directly (unit-style) will see the raw `formatValidationKey()` output. Examine each grep hit and adjust per the actual code path the test exercises. The translated wire output should match the pre-PR English literal (en locale default) for unchanged-locale tests.

- [ ] **Step 5: Run apps/api integration tests**

Run: `pnpm --filter @caliber/api test:integration`
Expected: All 254 integration tests PASS. If any assertion on `"Invalid rubric definition: ..."` was found in Step 4, it now passes because errorFormatter runs in integration context and produces the same English string.

- [ ] **Step 6: Typecheck apps/api**

Run: `pnpm --filter @caliber/api typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/trpc/routers/rubrics.ts
git commit -m "feat(api): translate rubrics invalid-definition throws via formatValidationKey"
```

---

## Task 7: Migrate `accountGroups.ts:372` platform-mismatch throw

**Files:**
- Modify: `apps/api/src/trpc/routers/accountGroups.ts`

- [ ] **Step 1: Add the import**

Inspect existing imports at the top of `apps/api/src/trpc/routers/accountGroups.ts`. Add to the existing `@caliber/i18n-validation` import if present, or add:

```typescript
import { formatValidationKey } from "@caliber/i18n-validation";
```

- [ ] **Step 2: Migrate `accountGroups.ts:369-374`**

Replace:
```typescript
      if (account.platform !== group.platform) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `account platform "${account.platform}" does not match group platform "${group.platform}"`,
        });
      }
```

with:
```typescript
      if (account.platform !== group.platform) {
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
      }
```

- [ ] **Step 3: Run apps/api tests**

Run: `pnpm --filter @caliber/api test && pnpm --filter @caliber/api test:integration`
Expected: All tests PASS. Check for any existing assertion on the old literal:
```bash
grep -rn 'does not match group platform' apps/api/tests/ 2>/dev/null || echo "no test assertions on literal string"
```
If found, update the assertion to expect the post-errorFormatter en string `Account platform "<x>" does not match group platform "<y>"` (note capital "Account" — the new translation capitalizes; previously it was lowercase "account"). Reconcile: either keep the test asserting on the existing lowercase string and adjust the en catalogue to lowercase, OR update the test. **Preferred:** update the test, since en catalogue uses sentence-case to match the rest of `validation.custom.*` keys.

- [ ] **Step 4: Typecheck apps/api**

Run: `pnpm --filter @caliber/api typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/trpc/routers/accountGroups.ts
git commit -m "feat(api): translate accountGroups platform-mismatch throw via formatValidationKey"
```

---

## Task 8: Extend `audit-zod-i18n.mjs` with `template` pattern

**Files:**
- Modify: `scripts/audit-zod-i18n.mjs`

- [ ] **Step 1: Add the new pattern entry**

In `scripts/audit-zod-i18n.mjs`, locate the `PATTERNS` array. Append a new entry to the end of the array:

```javascript
  // message: `...` — backtick template literal in addIssue or TRPCError.
  // After PR C all 4 known callsites migrate to formatValidationKey(...); this
  // pattern catches any future template-literal regression.
  {
    kind: "template",
    re: /message:\s*`([^`]+)`/g,
    msgGroup: 1,
  },
```

- [ ] **Step 2: Run the audit script on the current branch**

Run: `node scripts/audit-zod-i18n.mjs > /tmp/zod-i18n-audit-postpr.tsv`
Expected: command completes with exit 0. Inspect:
```bash
awk -F'\t' '$3=="template"' /tmp/zod-i18n-audit-postpr.tsv
```
Expected: 0 lines (all 4 migrated callsites now use `formatValidationKey(...)`, which is a function call, not a backtick string literal — regex does not match).

- [ ] **Step 3: Verify the pattern would catch a regression**

Run an inline sanity check (do NOT commit this file):
```bash
cat > /tmp/audit-probe.ts <<'EOF'
addIssue({ message: `Invalid thing: ${err}` });
EOF
node -e "
const {readFileSync} = require('node:fs');
const re = /message:\s*\`([^\`]+)\`/g;
const src = readFileSync('/tmp/audit-probe.ts', 'utf8');
const hits = [...src.matchAll(re)];
console.log('hits:', hits.length, hits.map(h => h[1]));
"
rm /tmp/audit-probe.ts
```
Expected: `hits: 1 [ 'Invalid thing: ${err}' ]` — confirms the regex matches a regression-shaped string.

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-zod-i18n.mjs
git commit -m "chore(audit): detect backtick-template message literals as kind=template"
```

---

## Task 9: Final verification — typecheck, full test suites, audit pre/post counts, docker smoke

**Files:** none (verification only — no commits unless a regression is found)

- [ ] **Step 1: Run the full monorepo typecheck**

Run: `pnpm -r typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run the full monorepo test suite**

Run: `pnpm -r test`
Expected:
- `@caliber/i18n-validation`: ~49 passing (46 existing + 3 new params cases + ~6 formatValidationKey cases ≈ 55, depending on exact count semantics)
- `@caliber/web`: 23 passing (22 existing + 1 new integration test)
- `@caliber/api`: 254 unit + integration tests passing (no regressions)

- [ ] **Step 3: Audit script pre/post diff**

Run on `main` branch (without merging):
```bash
git stash --include-untracked  # safety
git switch main
node scripts/audit-zod-i18n.mjs > /tmp/audit-main.tsv
awk -F'\t' '$3=="template"' /tmp/audit-main.tsv | tee /tmp/audit-main-template.tsv | wc -l
git switch feature/zod-i18n-params
git stash pop 2>/dev/null || true
node scripts/audit-zod-i18n.mjs > /tmp/audit-prc.tsv
awk -F'\t' '$3=="template"' /tmp/audit-prc.tsv | tee /tmp/audit-prc-template.tsv | wc -l
```
Expected:
- `/tmp/audit-main-template.tsv`: NOTE — main does not yet have the `template` pattern in audit. The audit run on main will skip the template kind. So the comparison is between "run audit on main with the patched script" (cherry-pick step below) and "run audit on PR branch with the patched script."

Simpler approach: run the **patched audit script** against both branches by copying the script content into a scratch location:
```bash
cp scripts/audit-zod-i18n.mjs /tmp/audit-patched.mjs
git switch main
node /tmp/audit-patched.mjs > /tmp/audit-main.tsv
awk -F'\t' '$3=="template"' /tmp/audit-main.tsv | wc -l
git switch feature/zod-i18n-params
node /tmp/audit-patched.mjs > /tmp/audit-prc.tsv
awk -F'\t' '$3=="template"' /tmp/audit-prc.tsv | wc -l
```
Expected:
- main count: **4** (the 4 template-literal hits this PR closes)
- PR branch count: **0**

Record both counts in the PR body Verification section.

- [ ] **Step 4: Local docker build + restart**

Run from the repo root:
```bash
pnpm -r build
VERSION=dev-prc-rc docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml build api web
VERSION=dev-prc-rc docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up -d api web
docker compose -f docker/docker-compose.yml ps
```
Expected: both `docker-api-1` and `docker-web-1` show `Up` status running the `dev-prc-rc` tag.

(Per user's `working_preferences`: the live-verification step is required before claiming work complete.)

- [ ] **Step 5: Manual UI smoke test from mac-mini at zh-TW locale**

In a browser pointed at the local instance (or mac-mini via Tailscale `100.64.0.4:3002`):
1. Switch UI to zh-TW locale
2. Navigate to evaluator → Rubrics → create new rubric
3. Paste invalid JSON in the definition field (e.g. `{ "tasks": "wrong" }`)
4. Trigger validation (submit / blur)
5. **Expect:** error text `無效的 rubric 定義：必須為有效的 JSON` (or similar; tail string is the live `result.error.issues` text)
6. **NOT expect:** raw key `validation.custom.evaluator.rubricInvalidDefinition#%7B...%7D`

Record observation in PR body.

- [ ] **Step 6: Manual server-path smoke test**

From terminal or admin UI, trigger a `accountGroups.addMember` call with mismatched platforms (account.platform != group.platform). Easiest path: pick an existing anthropic account and a group whose platform is e.g. `openai`, then attempt to add via admin UI.

**Expect:** toast / error response includes localized text matching the active locale (e.g. zh-TW: `帳號平台「anthropic」與群組平台「openai」不一致`).

If admin UI isn't wired to surface the error nicely, fall back to direct curl against tRPC:
```bash
curl -s -H "Cookie: NEXT_LOCALE=zh-TW" \
     -H "Content-Type: application/json" \
     -X POST http://localhost:3001/trpc/accountGroups.addMember \
     -d '{"json":{"accountId":"<anthropic-id>","groupId":"<openai-group-id>","priority":50}}'
```
**Expect:** `message` field in the JSON error response is the localized string.

- [ ] **Step 7: No commit at this task**

Verification only. If any step fails, return to the relevant earlier task and fix.

---

## Task 10: Open PR + update issue #134

**Files:**
- New PR via `gh pr create`
- Comment/edit on issue #134

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/zod-i18n-params
```

- [ ] **Step 2: Generate full PR diff for the PR body**

Run:
```bash
git log main..HEAD --oneline
git diff main...HEAD --stat
```
Capture both outputs to include in the PR body.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(i18n): runtime-interpolated Zod message params (PR C — series closeout)" --body "$(cat <<'EOF'
## Summary

Closes the Zod-i18n series by localizing the 4 remaining template-literal validation messages PR #136 deferred. Adds a small `packages/i18n-validation` capability — `formatValidationKey(key, params)` + params-aware `translateValidationKey` — so schema authors can attach `{name}` substitution data to a `validation.*` key in a single string that survives every boundary (`react-hook-form FieldError`, `ZodError.flatten()`, tRPC wire) without changes to any existing boundary translator.

Spec: [`docs/superpowers/specs/2026-05-14-zod-i18n-params-design.md`](../blob/main/docs/superpowers/specs/2026-05-14-zod-i18n-params-design.md)

## Why

`RubricEditor.tsx:58` and 3 server-side `TRPCError` throws (`rubrics.ts:104`, `rubrics.ts:174`, `accountGroups.ts:372`) emit messages whose final text depends on runtime values (Zod inner errors, platform identifiers). PR #136 deferred them because the existing tool-chain only handled static `validation.*` keys. This PR adds the runtime-param capability, migrates all 4, and adds an audit guard to catch future regressions.

## Changes

- `packages/i18n-validation/src/translate.ts` — added `formatValidationKey`, extended `translateValidationKey` to decode `#`-encoded URL-safe JSON payload
- `packages/i18n-validation/src/index.ts` — added `formatValidationKey` to barrel
- 5 locale catalogues — added 3 keys: `validation.custom.evaluator.rubricInvalidDefinition`, `validation.custom.accountGroups.{accountOrgMismatch,accountPlatformMismatch}`
- `apps/web/src/components/evaluator/RubricEditor.tsx` — 1 callsite
- `apps/api/src/trpc/routers/rubrics.ts` — 2 callsites
- `apps/api/src/trpc/routers/accountGroups.ts` — 1 callsite
- `scripts/audit-zod-i18n.mjs` — new `kind=template` pattern catching backtick-message regressions
- Tests: 9 new unit cases in `translate.test.ts` + 1 new hook-level integration case in `useTranslatedZodResolver.test.tsx`

## Verification

- [x] `pnpm -r typecheck` — 0 errors
- [x] `pnpm -r test` — all passing (i18n + web + api)
- [x] Audit script: main branch `kind=template` count = 4; PR branch count = 0
- [x] Local docker build + restart succeeded
- [x] Manual UI smoke: zh-TW locale, RubricEditor invalid-JSON path → translated message rendered
- [x] Manual server smoke: tRPC `accountGroups.addMember` with mismatched platforms → translated message in response

## Operator upgrade

None. No env, mount, helper, or migration. Pure code change.

## Follow-ups

- Issue #134 updated to include the 3 new keys in the native-speaker translation review backlog. `accountOrgMismatch` is catalogue-only in this PR (no callsite migrates).
EOF
)"
```

- [ ] **Step 4: Update issue #134 with the new keys**

Add a comment to issue #134:
```bash
gh issue comment 134 --body "$(cat <<'EOF'
PR C (#TBD-on-merge) adds 3 new `validation.custom.*` keys that join the native-speaker review backlog:

- `validation.custom.evaluator.rubricInvalidDefinition` — `Invalid rubric definition: {detail}`
- `validation.custom.accountGroups.accountOrgMismatch` — `Account does not belong to this group's org`
- `validation.custom.accountGroups.accountPlatformMismatch` — `Account platform "{accountPlatform}" does not match group platform "{groupPlatform}"`

All 5 locales (en/zh-TW/zh-CN/ja/ko) are LLM first-pass. zh-TW intentionally preserves the English word "rubric"; zh-CN uses "评分标准". Worth a native check before commercial release.
EOF
)"
```

Replace `#TBD-on-merge` with the actual PR number after Step 3 succeeds (or update the comment after PR opens).

- [ ] **Step 5: Confirm PR URL and report back**

Capture the PR URL from `gh pr create` output and surface it to the user as the deliverable. No further commit needed.

---

## Sign-off checklist

- [ ] All 10 tasks completed and committed.
- [ ] CI on the PR is green (typecheck + tests across i18n + web + api).
- [ ] PR body has both verification counts (test totals + audit pre/post).
- [ ] Issue #134 has been commented with the 3 new keys.
- [ ] No follow-up GitHub issue filed — `accountOrgMismatch` catalogue-only key is intentional groundwork, documented in the spec, not a deferred fix.
