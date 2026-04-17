# Foundation + Login Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a pnpm/Turborepo monorepo, define the full PostgreSQL schema with Drizzle migrations, and ship a working OAuth login end-to-end (Google + GitHub via Auth.js v5) with invite-only registration.

**Architecture:** Three apps (`cli` unchanged, new `api` Fastify+tRPC, new `web` Next.js 15), four shared packages (`core`, `db`, `auth`, `config`), single Postgres 16 DB, session cookies shared across apps. The CLI remains untouched.

**Tech Stack:** pnpm 9, Turborepo, TypeScript 5.7, Node 20, Next.js 15 App Router, Fastify 4, Drizzle ORM, PostgreSQL 16, Auth.js v5, zod, pino, vitest.

**Covers spec milestones:** M1 (monorepo scaffold) + M2 (DB schema) + M3 (Auth.js login works).

**Reference spec:** `.claude/plans/2026-04-17-foundation-auth-design.md`

**Version-verification note:** Next.js 15, Auth.js v5, Drizzle, tRPC v11 are all fast-moving. Where a task references a library API, verify current syntax against official docs before pasting — this plan pins known-good patterns as of 2026-04 but APIs drift.

---

## File Structure

This plan creates / modifies the following files. Use this map before starting — if something doesn't fit here, discuss before improvising.

```
aide/
├── .env.example                              CREATE
├── .gitignore                                MODIFY  (add .env, .turbo, coverage)
├── .github/
│   └── workflows/
│       └── ci.yml                            CREATE
├── .nvmrc                                    CREATE  (pin Node 20.x)
├── package.json                              MODIFY  (root = monorepo orchestrator)
├── pnpm-workspace.yaml                       CREATE
├── turbo.json                                CREATE
├── tsconfig.base.json                        CREATE  (shared TS config for workspaces)
├── tsconfig.json                             MODIFY  (CLI-only; still compiles src/)
├── docker/
│   └── docker-compose.dev.yml                CREATE
├── apps/
│   ├── cli/                                  UNTOUCHED (existing src/ stays put)
│   ├── api/                                  CREATE
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── server.ts                     Fastify bootstrap
│   │       ├── env.ts                        per-app env loader
│   │       ├── plugins/
│   │       │   ├── auth.ts                   session decoration
│   │       │   └── cookies.ts                @fastify/cookie registration
│   │       └── rest/
│   │           └── health.ts                 /health, /health/ready
│   └── web/                                  CREATE
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.mjs
│       ├── next-env.d.ts
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── page.tsx                  redirect to /sign-in or /dashboard
│           │   ├── api/auth/[...nextauth]/route.ts
│           │   ├── sign-in/page.tsx
│           │   └── dashboard/page.tsx
│           └── env.ts
├── packages/
│   ├── core/                                 CREATE (skeleton only)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   ├── config/                               CREATE
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── env.ts                        zod env schema
│   │   └── tests/env.test.ts
│   ├── db/                                   CREATE
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── index.ts                      db client
│   │   │   ├── schema/
│   │   │   │   ├── index.ts
│   │   │   │   ├── auth.ts                   Auth.js tables
│   │   │   │   ├── org.ts                    organizations, departments, teams
│   │   │   │   ├── membership.ts             *_members
│   │   │   │   ├── roles.ts                  role_assignments
│   │   │   │   ├── invites.ts
│   │   │   │   └── audit.ts                  audit_logs
│   │   │   ├── migrate.ts                    CLI: apply migrations
│   │   │   └── seed.ts                       CLI: dev seed
│   │   ├── tests/schema.test.ts
│   │   └── drizzle/                          generated migration SQL (committed)
│   └── auth/                                 CREATE
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── config.ts                     NextAuth config factory
│           ├── providers.ts                  Google + GitHub
│           ├── drizzle-adapter.ts
│           └── bootstrap.ts                  §4.4 sign-up decision logic
```

---

## Phase A: Monorepo Scaffold (M1 — Tasks 1–9)

### Task 1: Initialize pnpm workspace and root package.json

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `.nvmrc`
- Modify: `package.json` (replace with monorepo root)
- Modify: `.gitignore`
- Create: `tsconfig.base.json`

**Note:** The existing CLI package at `src/` must keep working. We rename the current root `package.json` scripts into a future `apps/cli/package.json` in a later sub-project; for this plan, the CLI stays at root until its migration. We preserve `bin`, `files`, `version`, `publishConfig` so npm publish still works.

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Modify root `package.json`**

```json
{
  "name": "@hanfour.huang/aide",
  "version": "0.1.0",
  "description": "aide — AI Development Performance Evaluator. Analyze Claude Code & Codex usage for technical performance review.",
  "type": "module",
  "private": false,
  "bin": { "aide": "./dist/cli.js" },
  "files": ["dist", "templates", "README.md"],
  "repository": { "type": "git", "url": "git+https://github.com/hanfour/aide.git" },
  "homepage": "https://hanfour.github.io/aide/",
  "bugs": { "url": "https://github.com/hanfour/aide/issues" },
  "engines": { "node": ">=20", "pnpm": ">=9" },
  "packageManager": "pnpm@9.15.0",
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "start": "node dist/cli.js",
    "test": "pnpm build && vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "pnpm build && pnpm test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "ws:build": "turbo run build",
    "ws:test": "turbo run test",
    "ws:dev": "turbo run dev --parallel"
  },
  "keywords": ["claude-code", "codex", "ai", "evaluation", "performance"],
  "license": "MIT",
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "chalk": "^5.4.1",
    "commander": "^13.1.0",
    "dayjs": "^1.11.13"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "turbo": "^2.3.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 5: Append to `.gitignore`**

```
.env
.env.*
!.env.example
.turbo/
coverage/
.next/
out/
```

- [ ] **Step 6: Install and verify**

Run: `pnpm install`

Expected: `node_modules/` populated; no errors. Existing CLI test run still works:

Run: `pnpm test`

Expected: existing test suite passes (no regressions).

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml .nvmrc tsconfig.base.json package.json .gitignore
git commit -m "chore: bootstrap pnpm workspace and turbo scaffolding"
```

---

### Task 2: Add `turbo.json` pipeline

**Files:**
- Create: `turbo.json`

- [ ] **Step 1: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "lint": { "outputs": [] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 2: Verify turbo runs**

Run: `pnpm turbo run typecheck --dry-run`

Expected: turbo lists zero tasks (no workspaces yet with typecheck) and exits 0.

- [ ] **Step 3: Commit**

```bash
git add turbo.json
git commit -m "chore: add turbo pipeline config"
```

---

### Task 3: Scaffold `packages/config` with zod env schema

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/index.ts`
- Create: `packages/config/src/env.ts`
- Create: `packages/config/tests/env.test.ts`

- [ ] **Step 1: Create `packages/config/package.json`**

```json
{
  "name": "@aide/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./env": "./src/env.ts"
  },
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `packages/config/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write the failing test — `packages/config/tests/env.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { parseServerEnv } from '../src/env'

describe('parseServerEnv', () => {
  const valid = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    AUTH_SECRET: 'a'.repeat(32),
    NEXTAUTH_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'g-id',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
    BOOTSTRAP_DEFAULT_ORG_SLUG: 'demo',
    BOOTSTRAP_DEFAULT_ORG_NAME: 'Demo Org'
  }

  it('parses a complete env', () => {
    const env = parseServerEnv(valid)
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.ENABLE_SWAGGER).toBe(false)
  })

  it('rejects AUTH_SECRET shorter than 32 chars', () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: 'short' })).toThrow()
  })

  it('rejects invalid DATABASE_URL', () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow()
  })

  it('rejects missing BOOTSTRAP_SUPER_ADMIN_EMAIL', () => {
    const { BOOTSTRAP_SUPER_ADMIN_EMAIL: _, ...rest } = valid
    expect(() => parseServerEnv(rest)).toThrow()
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @aide/config test`

Expected: FAIL — `parseServerEnv` does not exist.

- [ ] **Step 5: Implement `packages/config/src/env.ts`**

```typescript
import { z } from 'zod'

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  NEXTAUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_DEFAULT_ORG_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  BOOTSTRAP_DEFAULT_ORG_NAME: z.string().min(1),
  ENABLE_SWAGGER: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

export function parseServerEnv(raw: Record<string, unknown> = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return result.data
}
```

- [ ] **Step 6: Create `packages/config/src/index.ts`**

```typescript
export { parseServerEnv, serverEnvSchema } from './env.js'
export type { ServerEnv } from './env.js'
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @aide/config test`

Expected: 4 tests PASS.

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter @aide/config typecheck`

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/config
git commit -m "feat(config): add zod-validated server env schema"
```

---

### Task 4: Scaffold `packages/core` skeleton

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

**Rationale:** Reserve the name now so imports in later packages work. Content migration (moving existing `src/analyzers/*`) is a future sub-project.

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@aide/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/core/src/index.ts`**

```typescript
export const CORE_PACKAGE_NAME = '@aide/core'
```

- [ ] **Step 4: Verify**

Run: `pnpm install && pnpm --filter @aide/core typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): reserve @aide/core package skeleton"
```

---

### Task 5: Scaffold `packages/auth` skeleton (implementation in Phase C)

**Files:**
- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/src/index.ts`

- [ ] **Step 1: Create `packages/auth/package.json`**

```json
{
  "name": "@aide/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@aide/config": "workspace:*",
    "@aide/db": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `packages/auth/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/auth/src/index.ts`**

```typescript
export const AUTH_PACKAGE_NAME = '@aide/auth'
```

- [ ] **Step 4: Commit**

```bash
git add packages/auth
git commit -m "feat(auth): reserve @aide/auth package skeleton"
```

> Note: `pnpm install` will fail here because `@aide/db` does not yet exist. Do not run it. Task 10 creates `@aide/db`, after which install succeeds. If a CI step needs to install before Task 10, temporarily remove the `@aide/db` dependency line.

---

### Task 6: Scaffold `packages/db` skeleton (schema in Phase B)

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`

- [ ] **Step 1: Create `packages/db/package.json`**

```json
{
  "name": "@aide/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema/index.ts"
  },
  "scripts": {
    "build": "tsc",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/migrate.ts",
    "db:seed": "tsx src/seed.ts",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@aide/config": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `packages/db/src/index.ts`**

```typescript
export const DB_PACKAGE_NAME = '@aide/db'
```

- [ ] **Step 4: Install dependencies for workspace**

Run: `pnpm install`

Expected: all workspace packages link successfully.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @aide/db typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): reserve @aide/db package skeleton"
```

---

### Task 7: Scaffold `apps/api` Fastify "hello" server

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/rest/health.ts`
- Create: `apps/api/tests/health.test.ts`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@aide/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@aide/auth": "workspace:*",
    "@aide/config": "workspace:*",
    "@aide/db": "workspace:*",
    "@fastify/cookie": "^11.0.0",
    "fastify": "^5.1.0",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `apps/api/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
```

- [ ] **Step 4: Create `apps/api/src/env.ts`**

```typescript
import { parseServerEnv } from '@aide/config/env'
export const env = parseServerEnv()
```

- [ ] **Step 5: Create `apps/api/src/rest/health.ts`**

```typescript
import type { FastifyPluginAsync } from 'fastify'

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? 'dev',
    db: 'unchecked'
  }))

  fastify.get('/health/ready', async (_req, reply) => {
    reply.code(200)
    return { status: 'ready' }
  })
}
```

- [ ] **Step 6: Write the failing test — `apps/api/tests/health.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { healthRoutes } from '../src/rest/health'

describe('health routes', () => {
  it('GET /health returns ok', async () => {
    const app = Fastify()
    await app.register(healthRoutes)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    await app.close()
  })

  it('GET /health/ready returns 200', async () => {
    const app = Fastify()
    await app.register(healthRoutes)
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
```

- [ ] **Step 7: Run test to verify it passes (routes already implemented above)**

Run: `pnpm --filter @aide/api test`

Expected: both tests PASS.

- [ ] **Step 8: Create `apps/api/src/server.ts`**

```typescript
import Fastify from 'fastify'
import { healthRoutes } from './rest/health.js'

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty' }
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID()
  })

  await app.register(healthRoutes)
  return app
}

async function main() {
  const app = await buildServer()
  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 9: Add pino-pretty as dev dependency**

Run: `pnpm --filter @aide/api add -D pino-pretty`

- [ ] **Step 10: Manual smoke test**

Run: `pnpm --filter @aide/api dev`

Then in another terminal: `curl http://localhost:3001/health`

Expected: `{"status":"ok",...}`. Stop the dev server with Ctrl-C.

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat(api): scaffold Fastify server with health routes"
```

---

### Task 8: Scaffold `apps/web` Next.js 15 app

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/next-env.d.ts`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`

**Note:** This task only produces a blank "hello" page. Sign-in / dashboard pages arrive in Phase C. Verify Next.js 15 App Router API shapes (especially layouts and metadata) against current docs before pasting.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@aide/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build",
    "dev": "next dev -p 3000",
    "start": "next start -p 3000",
    "lint": "next lint --dir src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@aide/auth": "workspace:*",
    "@aide/config": "workspace:*",
    "@aide/db": "workspace:*",
    "next": "^15.1.0",
    "next-auth": "5.0.0-beta.25",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "eslint": "^9.15.0",
    "eslint-config-next": "^15.1.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `apps/web/next.config.mjs`**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@aide/auth', '@aide/config', '@aide/db']
}

export default nextConfig
```

- [ ] **Step 4: Create `apps/web/next-env.d.ts`**

```typescript
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 5: Create `apps/web/src/app/layout.tsx`**

```typescript
import type { ReactNode } from 'react'

export const metadata = {
  title: 'aide',
  description: 'AI Development Performance Evaluator'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 6: Create `apps/web/src/app/page.tsx`**

```typescript
export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>aide</h1>
      <p>AI Development Performance Evaluator — platform preview</p>
    </main>
  )
}
```

- [ ] **Step 7: Install and build**

Run: `pnpm install && pnpm --filter @aide/web build`

Expected: Next.js build succeeds; `.next/` output generated.

- [ ] **Step 8: Manual smoke test**

Run: `pnpm --filter @aide/web dev`

Open `http://localhost:3000` — see "aide" heading. Stop with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): scaffold Next.js 15 App Router app"
```

---

### Task 9: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-type-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run lint typecheck test build
```

- [ ] **Step 2: Sanity run locally (must pass before pushing)**

Run: `pnpm install --frozen-lockfile && pnpm turbo run lint typecheck test build`

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add turbo-based lint/typecheck/test/build workflow"
```

---

**Phase A complete.** Repo now has working monorepo scaffolding, two live apps (Fastify + Next.js), three empty packages, and CI.

---

## Phase B: Database Schema & Migrations (M2 — Tasks 10–17)

### Task 10: Docker Compose for dev Postgres

**Files:**
- Create: `docker/docker-compose.dev.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `docker/docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: aide
      POSTGRES_USER: aide
      POSTGRES_PASSWORD: aide_dev
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aide"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pg_data:
```

- [ ] **Step 2: Create `.env.example`**

```
NODE_ENV=development
DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
AUTH_SECRET=replace-with-32-plus-chars-random-string-xxxxxxxxxxxxxx
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_DEFAULT_ORG_SLUG=demo
BOOTSTRAP_DEFAULT_ORG_NAME=Demo Org
LOG_LEVEL=info
# ENABLE_SWAGGER=true  # uncomment to expose /docs in production
```

- [ ] **Step 3: Start Postgres**

Run: `docker compose -f docker/docker-compose.dev.yml up -d postgres`

Verify: `docker compose -f docker/docker-compose.dev.yml ps` shows `healthy`.

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.dev.yml .env.example
git commit -m "chore: add dev docker-compose for postgres and .env example"
```

---

### Task 11: Drizzle config and DB client

**Files:**
- Create: `packages/db/drizzle.config.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Create `packages/db/drizzle.config.ts`**

```typescript
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://aide:aide_dev@localhost:5432/aide'
  },
  strict: true,
  verbose: true
})
```

- [ ] **Step 2: Replace `packages/db/src/index.ts`**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema/index.js'

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  const db = drizzle(pool, { schema })
  return { db, pool }
}

export type Database = ReturnType<typeof createDb>['db']
export { schema }
export * from './schema/index.js'
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/drizzle.config.ts packages/db/src/index.ts
git commit -m "feat(db): add drizzle config and db client factory"
```

---

### Task 12: Schema — Auth.js standard tables

**Files:**
- Create: `packages/db/src/schema/auth.ts`

- [ ] **Step 1: Create `packages/db/src/schema/auth.ts`**

```typescript
import {
  pgTable, text, timestamp, primaryKey, integer, uuid
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refreshToken: text('refresh_token'),
    accessToken: text('access_token'),
    expiresAt: integer('expires_at'),
    tokenType: text('token_type'),
    scope: text('scope'),
    idToken: text('id_token'),
    sessionState: text('session_state')
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] })
  })
)

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull()
})

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull()
  },
  (t) => ({ pk: primaryKey({ columns: [t.identifier, t.token] }) })
)
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema/auth.ts
git commit -m "feat(db): add Auth.js standard tables schema"
```

---

### Task 13: Schema — organizations, departments, teams

**Files:**
- Create: `packages/db/src/schema/org.ts`

- [ ] **Step 1: Create `packages/db/src/schema/org.ts`**

```typescript
import { pgTable, text, timestamp, uuid, unique, type AnyPgColumn } from 'drizzle-orm/pg-core'

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
})

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
  },
  (t) => ({ uniqOrgSlug: unique('departments_org_slug_unique').on(t.orgId, t.slug) })
)

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    parentTeamId: uuid('parent_team_id').references((): AnyPgColumn => teams.id, {
      onDelete: 'set null'
    }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
  },
  (t) => ({ uniqOrgSlug: unique('teams_org_slug_unique').on(t.orgId, t.slug) })
)
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema/org.ts
git commit -m "feat(db): add organizations, departments, teams schema"
```

---

### Task 14: Schema — membership tables

**Files:**
- Create: `packages/db/src/schema/membership.ts`

- [ ] **Step 1: Create `packages/db/src/schema/membership.ts`**

```typescript
import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations, teams } from './org.js'

export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ pk: primaryKey({ columns: [t.orgId, t.userId] }) })
)

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamId, t.userId] }) })
)
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema/membership.ts
git commit -m "feat(db): add organization_members and team_members schema"
```

---

### Task 15: Schema — role_assignments

**Files:**
- Create: `packages/db/src/schema/roles.ts`

- [ ] **Step 1: Create `packages/db/src/schema/roles.ts`**

```typescript
import { pgTable, text, timestamp, uuid, index, pgEnum } from 'drizzle-orm/pg-core'
import { users } from './auth.js'

export const roleEnum = pgEnum('role_name', [
  'super_admin',
  'org_admin',
  'dept_manager',
  'team_manager',
  'member'
])

export const scopeTypeEnum = pgEnum('scope_type', [
  'global',
  'organization',
  'department',
  'team'
])

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true })
  },
  (t) => ({
    activeByUser: index('idx_role_assignments_user_active')
      .on(t.userId)
      .where(({ revokedAt }) => `${revokedAt} is null`)
  })
)
```

> If drizzle-kit complains about the partial-index syntax, fall back to a plain index on `userId` and rely on a WHERE clause at query time. Update the migration SQL manually to add `WHERE revoked_at IS NULL` after `drizzle-kit generate`.

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema/roles.ts
git commit -m "feat(db): add role_assignments with role/scope enums"
```

---

### Task 16: Schema — invites

**Files:**
- Create: `packages/db/src/schema/invites.ts`

- [ ] **Step 1: Create `packages/db/src/schema/invites.ts`**

```typescript
import { pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations } from './org.js'
import { roleEnum, scopeTypeEnum } from './roles.js'

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    invitedBy: uuid('invited_by').notNull().references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    token: text('token').notNull().unique()
  },
  (t) => ({ uniqOrgEmail: unique('invites_org_email_unique').on(t.orgId, t.email) })
)
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema/invites.ts
git commit -m "feat(db): add invites schema"
```

---

### Task 17: Schema — audit_logs and barrel export

**Files:**
- Create: `packages/db/src/schema/audit.ts`
- Create: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create `packages/db/src/schema/audit.ts`**

```typescript
import { pgTable, text, timestamp, uuid, jsonb, bigserial, index } from 'drizzle-orm/pg-core'
import { users } from './auth.js'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    orgId: uuid('org_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    orgCreated: index('idx_audit_logs_org_created').on(t.orgId, t.createdAt)
  })
)
```

- [ ] **Step 2: Create `packages/db/src/schema/index.ts`**

```typescript
export * from './auth.js'
export * from './org.js'
export * from './membership.js'
export * from './roles.js'
export * from './invites.js'
export * from './audit.js'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aide/db typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/audit.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add audit_logs and schema barrel export"
```

---

### Task 18: Generate initial migration SQL

**Files:**
- Create: `packages/db/drizzle/0000_init.sql` (and any companion `_journal.json` / `_meta`)

- [ ] **Step 1: Ensure Postgres dev is running**

Run: `docker compose -f docker/docker-compose.dev.yml up -d postgres`

- [ ] **Step 2: Export `DATABASE_URL` for drizzle-kit**

```bash
export DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
```

- [ ] **Step 3: Generate migration**

Run: `pnpm --filter @aide/db db:generate`

Expected: files written under `packages/db/drizzle/` — including `0000_<auto-name>.sql` containing `CREATE TABLE organizations`, `...teams`, `...role_assignments`, etc.

- [ ] **Step 4: Inspect the SQL**

Open `packages/db/drizzle/0000_*.sql` and verify:

- All 10 tables present (`users`, `accounts`, `sessions`, `verification_tokens`, `organizations`, `departments`, `teams`, `organization_members`, `team_members`, `role_assignments`, `invites`, `audit_logs`)
- Enum types `role_name` and `scope_type` created
- Indexes `idx_role_assignments_user_active` and `idx_audit_logs_org_created` present
- All `uuid` primary keys use `gen_random_uuid()`

If the partial-index `WHERE revoked_at IS NULL` clause is missing from `idx_role_assignments_user_active`, edit the SQL file to append ` WHERE "revoked_at" IS NULL` at the end of that `CREATE INDEX` statement.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle
git commit -m "feat(db): generate initial migration SQL (0000_init)"
```

---

### Task 19: Migration runner script

**Files:**
- Create: `packages/db/src/migrate.ts`

- [ ] **Step 1: Create `packages/db/src/migrate.ts`**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')

  const pool = new pg.Pool({ connectionString: url, max: 1 })
  const db = drizzle(pool)

  const here = path.dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = path.resolve(here, '..', 'drizzle')

  console.log(`Applying migrations from ${migrationsFolder}`)
  await migrate(db, { migrationsFolder })
  console.log('Migrations complete.')

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Run it**

```bash
export DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
pnpm --filter @aide/db db:migrate
```

Expected: `Migrations complete.` — DB now contains all tables. Verify:

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U aide -d aide -c "\dt"
```

Expected: all 10 tables listed plus `__drizzle_migrations` metadata table.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/migrate.ts
git commit -m "feat(db): add migration runner script"
```

---

### Task 20: Dev seed script

**Files:**
- Create: `packages/db/src/seed.ts`

- [ ] **Step 1: Create `packages/db/src/seed.ts`**

```typescript
import { createDb } from './index.js'
import { organizations, users } from './schema/index.js'
import { organizationMembers } from './schema/membership.js'
import { roleAssignments } from './schema/roles.js'
import { eq } from 'drizzle-orm'

async function main() {
  const url = process.env.DATABASE_URL
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL
  const orgSlug = process.env.BOOTSTRAP_DEFAULT_ORG_SLUG ?? 'demo'
  const orgName = process.env.BOOTSTRAP_DEFAULT_ORG_NAME ?? 'Demo Org'

  if (!url) throw new Error('DATABASE_URL is required')
  if (!email) throw new Error('BOOTSTRAP_SUPER_ADMIN_EMAIL is required')

  const { db, pool } = createDb(url)

  const existingOrg = await db.query.organizations.findFirst({
    where: eq(organizations.slug, orgSlug)
  })
  const org =
    existingOrg ??
    (await db
      .insert(organizations)
      .values({ slug: orgSlug, name: orgName })
      .returning()
      .then((r) => r[0]!))

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) })
  const user =
    existingUser ??
    (await db
      .insert(users)
      .values({ email, name: 'Bootstrap Super Admin' })
      .returning()
      .then((r) => r[0]!))

  await db
    .insert(organizationMembers)
    .values({ orgId: org.id, userId: user.id })
    .onConflictDoNothing()

  const existingRole = await db.query.roleAssignments.findFirst({
    where: (ra, { and, eq, isNull }) =>
      and(eq(ra.userId, user.id), eq(ra.role, 'super_admin'), isNull(ra.revokedAt))
  })

  if (!existingRole) {
    await db.insert(roleAssignments).values({
      userId: user.id,
      role: 'super_admin',
      scopeType: 'global'
    })
  }

  console.log(`Seeded org ${org.slug} (${org.id}) and super_admin ${user.email} (${user.id})`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Run it**

```bash
export DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
export BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
export BOOTSTRAP_DEFAULT_ORG_SLUG=demo
export BOOTSTRAP_DEFAULT_ORG_NAME="Demo Org"
pnpm --filter @aide/db db:seed
```

Expected: `Seeded org demo (...) and super_admin admin@example.com (...)`.

- [ ] **Step 3: Verify idempotency**

Run the seed command again. It must succeed without creating duplicates.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): add idempotent dev seed script"
```

---

### Task 21: Schema integration test (round-trip migrate + insert + query)

**Files:**
- Create: `packages/db/tests/schema.test.ts`
- Create: `packages/db/vitest.config.ts`

- [ ] **Step 1: Add `pg-mem` or `@testcontainers/postgresql` dev dep**

Run: `pnpm --filter @aide/db add -D @testcontainers/postgresql`

- [ ] **Step 2: Create `packages/db/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
```

- [ ] **Step 3: Write the failing test — `packages/db/tests/schema.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { organizations, users } from '../src/schema/index.js'
import { organizationMembers } from '../src/schema/membership.js'
import { roleAssignments } from '../src/schema/roles.js'
import { eq } from 'drizzle-orm'

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  db = drizzle(pool)
  const here = path.dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: path.resolve(here, '..', 'drizzle') })
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

describe('schema round-trip', () => {
  it('creates an org and super_admin with role_assignment', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: 'test-org', name: 'Test' })
      .returning()

    const [user] = await db
      .insert(users)
      .values({ email: 'root@test.com', name: 'Root' })
      .returning()

    await db
      .insert(organizationMembers)
      .values({ orgId: org!.id, userId: user!.id })

    const [ra] = await db
      .insert(roleAssignments)
      .values({ userId: user!.id, role: 'super_admin', scopeType: 'global' })
      .returning()

    expect(ra?.role).toBe('super_admin')
    expect(ra?.scopeType).toBe('global')
  })

  it('rejects duplicate org slug', async () => {
    await db.insert(organizations).values({ slug: 'dup', name: 'A' })
    await expect(
      db.insert(organizations).values({ slug: 'dup', name: 'B' })
    ).rejects.toThrow()
  })

  it('rejects duplicate team slug within same org', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: 'unique-slug-org', name: 'X' })
      .returning()

    const { teams } = await import('../src/schema/index.js')
    await db.insert(teams).values({ orgId: org!.id, name: 'A', slug: 'engineering' })
    await expect(
      db.insert(teams).values({ orgId: org!.id, name: 'B', slug: 'engineering' })
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @aide/db test`

Expected: 3 tests PASS. First run may be slow (~30 s to pull pg image).

- [ ] **Step 5: Commit**

```bash
git add packages/db/tests packages/db/vitest.config.ts packages/db/package.json pnpm-lock.yaml
git commit -m "test(db): add schema round-trip integration tests"
```

---

### Task 22: Verify full dev bring-up

**Files:** none (verification task)

- [ ] **Step 1: Shut down and restart Postgres clean**

```bash
docker compose -f docker/docker-compose.dev.yml down -v
docker compose -f docker/docker-compose.dev.yml up -d postgres
```

- [ ] **Step 2: Apply migrations**

```bash
export DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
pnpm --filter @aide/db db:migrate
```

Expected: `Migrations complete.`

- [ ] **Step 3: Run seed**

```bash
export BOOTSTRAP_SUPER_ADMIN_EMAIL=admin@example.com
export BOOTSTRAP_DEFAULT_ORG_SLUG=demo
export BOOTSTRAP_DEFAULT_ORG_NAME="Demo Org"
pnpm --filter @aide/db db:seed
```

Expected: one line of seeded output.

- [ ] **Step 4: Inspect DB**

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U aide -d aide -c "select email from users;"
docker exec -it $(docker ps -qf name=postgres) psql -U aide -d aide -c "select role, scope_type from role_assignments;"
```

Expected: one user `admin@example.com`, one role row `super_admin | global`.

- [ ] **Step 5: Run full workspace tests**

Run: `pnpm turbo run test`

Expected: all packages green.

No commit needed (no code changed).

---

**Phase B complete.** DB schema is live, migrations are repeatable, seed is idempotent, and schema invariants are tested.

---

## Phase C: Auth.js Login End-to-End (M3 — Tasks 23–33)

### Task 23: `packages/auth` — OAuth providers and drizzle adapter

**Files:**
- Create: `packages/auth/src/providers.ts`
- Create: `packages/auth/src/drizzle-adapter.ts`

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @aide/auth add next-auth@5.0.0-beta.25 @auth/drizzle-adapter@^1.7.0 @auth/core
```

> Verify against https://authjs.dev that the listed versions are the current recommended combination. Auth.js v5 is beta; pin exact versions once chosen.

- [ ] **Step 2: Create `packages/auth/src/providers.ts`**

```typescript
import Google from 'next-auth/providers/google'
import GitHub from 'next-auth/providers/github'

export function buildProviders(env: {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
}) {
  return [
    Google({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: false
    }),
    GitHub({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: false
    })
  ]
}
```

- [ ] **Step 3: Create `packages/auth/src/drizzle-adapter.ts`**

```typescript
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import type { Database } from '@aide/db'
import { users, accounts, sessions, verificationTokens } from '@aide/db'

export function makeAdapter(db: Database) {
  return DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens
  })
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/auth/src/providers.ts packages/auth/src/drizzle-adapter.ts packages/auth/package.json pnpm-lock.yaml
git commit -m "feat(auth): add OAuth providers and Drizzle adapter wiring"
```

---

### Task 24: `packages/auth` — bootstrap decision logic (§4.4)

**Files:**
- Create: `packages/auth/src/bootstrap.ts`
- Create: `packages/auth/tests/bootstrap.test.ts`
- Create: `packages/auth/vitest.config.ts`

- [ ] **Step 1: Add testcontainers dev dep**

Run: `pnpm --filter @aide/auth add -D @testcontainers/postgresql vitest typescript`

- [ ] **Step 2: Create `packages/auth/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
```

- [ ] **Step 3: Write the failing test — `packages/auth/tests/bootstrap.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { createRequire } from 'node:module'
import { decideSignUp, type BootstrapConfig } from '../src/bootstrap'

const require = createRequire(import.meta.url)
const migrationsFolder = path.resolve(
  path.dirname(require.resolve('@aide/db/package.json')),
  'drizzle'
)

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let db: ReturnType<typeof drizzle>

const cfg: BootstrapConfig = {
  superAdminEmail: 'admin@example.com',
  defaultOrgSlug: 'demo',
  defaultOrgName: 'Demo'
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  db = drizzle(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

describe('decideSignUp', () => {
  it('allows first user when email matches BOOTSTRAP_SUPER_ADMIN_EMAIL', async () => {
    const decision = await decideSignUp(db, 'admin@example.com', cfg)
    expect(decision.allowed).toBe(true)
    expect(decision.action).toBe('bootstrap')
  })

  it('denies first user when email does NOT match admin email', async () => {
    const decision = await decideSignUp(db, 'stranger@example.com', cfg)
    expect(decision.allowed).toBe(false)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @aide/auth test`

Expected: FAIL — `decideSignUp` does not exist.

- [ ] **Step 5: Implement `packages/auth/src/bootstrap.ts`**

```typescript
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '@aide/db'
import { users, invites, organizations } from '@aide/db'

export interface BootstrapConfig {
  superAdminEmail: string
  defaultOrgSlug: string
  defaultOrgName: string
}

export type SignUpDecision =
  | { allowed: true; action: 'link'; userId: string }
  | { allowed: true; action: 'invite'; inviteId: string; orgId: string }
  | { allowed: true; action: 'bootstrap' }
  | { allowed: false; reason: 'no-invite' | 'invite-expired' }

export async function decideSignUp(
  db: Database,
  email: string,
  cfg: BootstrapConfig
): Promise<SignUpDecision> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (existing) {
    return { allowed: true, action: 'link', userId: existing.id }
  }

  const now = new Date()
  const invite = await db.query.invites.findFirst({
    where: and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, now))
  })
  if (invite) {
    return { allowed: true, action: 'invite', inviteId: invite.id, orgId: invite.orgId }
  }

  const anyUser = await db.query.users.findFirst()
  if (!anyUser && email === cfg.superAdminEmail) {
    return { allowed: true, action: 'bootstrap' }
  }

  return { allowed: false, reason: 'no-invite' }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @aide/auth test`

Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/auth/src/bootstrap.ts packages/auth/tests packages/auth/vitest.config.ts packages/auth/package.json pnpm-lock.yaml
git commit -m "feat(auth): add invite-only sign-up decision logic (§4.4)"
```

---

### Task 25: `packages/auth` — NextAuth config factory

**Files:**
- Create: `packages/auth/src/config.ts`
- Modify: `packages/auth/src/index.ts`

- [ ] **Step 1: Create `packages/auth/src/config.ts`**

```typescript
import type { NextAuthConfig } from 'next-auth'
import type { Database } from '@aide/db'
import { organizations, users, organizationMembers, invites } from '@aide/db'
import { roleAssignments } from '@aide/db'
import { eq } from 'drizzle-orm'
import { buildProviders } from './providers.js'
import { makeAdapter } from './drizzle-adapter.js'
import { decideSignUp, type BootstrapConfig } from './bootstrap.js'

export interface AuthEnv extends BootstrapConfig {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  AUTH_SECRET: string
}

export function buildAuthConfig(db: Database, env: AuthEnv): NextAuthConfig {
  return {
    adapter: makeAdapter(db),
    secret: env.AUTH_SECRET,
    session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
    providers: buildProviders(env),
    callbacks: {
      async signIn({ user }) {
        const email = user.email
        if (!email) return false
        const decision = await decideSignUp(db, email, env)
        return decision.allowed
      }
    },
    events: {
      async createUser({ user }) {
        if (!user.email || !user.id) return

        const decision = await decideSignUp(db, user.email, env)
        if (!decision.allowed) return

        if (decision.action === 'bootstrap') {
          const [org] = await db
            .insert(organizations)
            .values({ slug: env.defaultOrgSlug, name: env.defaultOrgName })
            .onConflictDoNothing()
            .returning()

          const resolvedOrg =
            org ??
            (await db.query.organizations.findFirst({
              where: eq(organizations.slug, env.defaultOrgSlug)
            }))

          if (resolvedOrg) {
            await db
              .insert(organizationMembers)
              .values({ orgId: resolvedOrg.id, userId: user.id })
              .onConflictDoNothing()
            await db.insert(roleAssignments).values({
              userId: user.id,
              role: 'super_admin',
              scopeType: 'global'
            })
          }
        } else if (decision.action === 'invite') {
          await db
            .insert(organizationMembers)
            .values({ orgId: decision.orgId, userId: user.id })
            .onConflictDoNothing()
          const inv = await db.query.invites.findFirst({ where: eq(invites.id, decision.inviteId) })
          if (inv) {
            await db.insert(roleAssignments).values({
              userId: user.id,
              role: inv.role,
              scopeType: inv.scopeType,
              scopeId: inv.scopeId
            })
            await db
              .update(invites)
              .set({ acceptedAt: new Date() })
              .where(eq(invites.id, inv.id))
          }
        }
      }
    },
    pages: { signIn: '/sign-in' }
  }
}
```

- [ ] **Step 2: Replace `packages/auth/src/index.ts`**

```typescript
export { buildAuthConfig, type AuthEnv } from './config.js'
export { decideSignUp, type SignUpDecision, type BootstrapConfig } from './bootstrap.js'
export { buildProviders } from './providers.js'
export { makeAdapter } from './drizzle-adapter.js'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aide/auth typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/auth/src/config.ts packages/auth/src/index.ts
git commit -m "feat(auth): NextAuth config factory with signIn/createUser hooks"
```

---

### Task 26: `apps/web` — NextAuth route handler and server helper

**Files:**
- Create: `apps/web/src/env.ts`
- Create: `apps/web/src/auth.ts`
- Create: `apps/web/src/app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Create `apps/web/src/env.ts`**

```typescript
import { parseServerEnv } from '@aide/config/env'
export const env = parseServerEnv()
```

- [ ] **Step 2: Create `apps/web/src/auth.ts`**

```typescript
import NextAuth from 'next-auth'
import { createDb } from '@aide/db'
import { buildAuthConfig } from '@aide/auth'
import { env } from './env.js'

const { db } = createDb(env.DATABASE_URL)

export const { handlers, auth, signIn, signOut } = NextAuth(
  buildAuthConfig(db, {
    AUTH_SECRET: env.AUTH_SECRET,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    superAdminEmail: env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
    defaultOrgSlug: env.BOOTSTRAP_DEFAULT_ORG_SLUG,
    defaultOrgName: env.BOOTSTRAP_DEFAULT_ORG_NAME
  })
)
```

- [ ] **Step 3: Create `apps/web/src/app/api/auth/[...nextauth]/route.ts`**

```typescript
export { GET, POST } from '@/auth'

// `@/auth` resolves via the tsconfig path alias `@/* -> src/*`.
// Adjust the import to a relative path if your setup differs.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/env.ts apps/web/src/auth.ts apps/web/src/app/api/auth
git commit -m "feat(web): wire NextAuth route handler to @aide/auth config"
```

---

### Task 27: `apps/web` — sign-in page

**Files:**
- Create: `apps/web/src/app/sign-in/page.tsx`

- [ ] **Step 1: Create `apps/web/src/app/sign-in/page.tsx`**

```typescript
import { signIn } from '@/auth'

export default function SignInPage() {
  async function signInGoogle() {
    'use server'
    await signIn('google', { redirectTo: '/dashboard' })
  }
  async function signInGitHub() {
    'use server'
    await signIn('github', { redirectTo: '/dashboard' })
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Sign in to aide</h1>
      <form action={signInGoogle}>
        <button type="submit">Sign in with Google</button>
      </form>
      <form action={signInGitHub} style={{ marginTop: 12 }}>
        <button type="submit">Sign in with GitHub</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/sign-in
git commit -m "feat(web): add sign-in page with Google/GitHub buttons"
```

---

### Task 28: `apps/web` — protected dashboard and home redirect

**Files:**
- Create: `apps/web/src/app/dashboard/page.tsx`
- Modify: `apps/web/src/app/page.tsx`

- [ ] **Step 1: Create `apps/web/src/app/dashboard/page.tsx`**

```typescript
import { auth, signOut } from '@/auth'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/sign-in')

  async function doSignOut() {
    'use server'
    await signOut({ redirectTo: '/sign-in' })
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <form action={doSignOut}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Replace `apps/web/src/app/page.tsx`**

```typescript
import { auth } from '@/auth'
import { redirect } from 'next/navigation'

export default async function HomePage() {
  const session = await auth()
  redirect(session?.user ? '/dashboard' : '/sign-in')
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/dashboard apps/web/src/app/page.tsx
git commit -m "feat(web): add protected dashboard and home redirect"
```

---

### Task 29: `apps/api` — cookies plugin and session decorator

**Files:**
- Create: `apps/api/src/plugins/cookies.ts`
- Create: `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Create `apps/api/src/plugins/cookies.ts`**

```typescript
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import fastifyCookie from '@fastify/cookie'

export const cookiesPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(fastifyCookie, {
    parseOptions: { sameSite: 'lax', httpOnly: true }
  })
})
```

- [ ] **Step 2: Install `fastify-plugin`**

Run: `pnpm --filter @aide/api add fastify-plugin`

- [ ] **Step 3: Create `apps/api/src/plugins/auth.ts`**

```typescript
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { eq } from 'drizzle-orm'
import { createDb, sessions, users } from '@aide/db'
import type { ServerEnv } from '@aide/config'

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string } | null
  }
}

export interface AuthPluginOptions { env: ServerEnv }

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = fp(async (fastify, opts) => {
  const { db, pool } = createDb(opts.env.DATABASE_URL)
  fastify.addHook('onClose', async () => { await pool.end() })
  fastify.decorateRequest('user', null)

  // NextAuth v5 defaults the session cookie name per NODE_ENV.
  const cookieName =
    opts.env.NODE_ENV === 'production'
      ? '__Secure-authjs.session-token'
      : 'authjs.session-token'

  fastify.addHook('onRequest', async (req) => {
    const token = req.cookies[cookieName]
    if (!token) return

    const row = await db
      .select({
        userId: sessions.userId,
        expires: sessions.expires,
        email: users.email
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.sessionToken, token))
      .limit(1)
      .then((r) => r[0])

    if (row && row.expires > new Date()) {
      req.user = { id: row.userId, email: row.email }
    }
  })
})
```

> Verify the NextAuth v5 cookie name against current docs — the default has changed between betas. Mismatching names silently breaks auth.

- [ ] **Step 4: Replace `apps/api/src/server.ts`**

```typescript
import Fastify from 'fastify'
import { parseServerEnv } from '@aide/config/env'
import { healthRoutes } from './rest/health.js'
import { cookiesPlugin } from './plugins/cookies.js'
import { authPlugin } from './plugins/auth.js'

export async function buildServer() {
  const env = parseServerEnv()
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID()
  })

  await app.register(cookiesPlugin)
  await app.register(authPlugin, { env })
  await app.register(healthRoutes)

  return app
}

async function main() {
  const app = await buildServer()
  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @aide/api typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add cookie + session-reading auth plugin"
```

---

### Task 30: `apps/api` — integration test that auth plugin reads a session

**Files:**
- Create: `apps/api/vitest.integration.config.ts`
- Create: `apps/api/tests/integration/auth.test.ts`

- [ ] **Step 1: Add testcontainers**

Run: `pnpm --filter @aide/api add -D @testcontainers/postgresql`

- [ ] **Step 2: Create `apps/api/vitest.integration.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
```

- [ ] **Step 3: Add script to `apps/api/package.json`**

Modify the `scripts` block to add:

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 4: Write the failing test — `apps/api/tests/integration/auth.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { cookiesPlugin } from '../../src/plugins/cookies.js'
import { authPlugin } from '../../src/plugins/auth.js'
import { sessions, users } from '@aide/db'

const require = createRequire(import.meta.url)
const migrationsFolder = path.resolve(
  path.dirname(require.resolve('@aide/db/package.json')),
  'drizzle'
)

let container: StartedPostgreSqlContainer
let pool: pg.Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  const db = drizzle(pool)
  await migrate(db, { migrationsFolder })

  const [user] = await db
    .insert(users)
    .values({ email: 'u@test.com', name: 'U' })
    .returning()

  await db.insert(sessions).values({
    sessionToken: 'test-token',
    userId: user!.id,
    expires: new Date(Date.now() + 60_000)
  })
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

function env(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test' as const,
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: 'a'.repeat(32),
    NEXTAUTH_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'x',
    GOOGLE_CLIENT_SECRET: 'x',
    GITHUB_CLIENT_ID: 'x',
    GITHUB_CLIENT_SECRET: 'x',
    BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
    BOOTSTRAP_DEFAULT_ORG_SLUG: 'demo',
    BOOTSTRAP_DEFAULT_ORG_NAME: 'Demo',
    LOG_LEVEL: 'error' as const,
    ENABLE_SWAGGER: false,
    ...overrides
  }
}

describe('authPlugin', () => {
  it('decorates req.user when a valid session cookie is present', async () => {
    const app = Fastify()
    await app.register(cookiesPlugin)
    await app.register(authPlugin, { env: env() })
    app.get('/who', async (req) => ({ user: req.user }))

    const res = await app.inject({
      method: 'GET',
      url: '/who',
      cookies: { 'authjs.session-token': 'test-token' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ email: 'u@test.com' })
    await app.close()
  })

  it('leaves req.user null when no cookie present', async () => {
    const app = Fastify()
    await app.register(cookiesPlugin)
    await app.register(authPlugin, { env: env() })
    app.get('/who', async (req) => ({ user: req.user }))

    const res = await app.inject({ method: 'GET', url: '/who' })
    expect(res.json().user).toBeNull()
    await app.close()
  })
})
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @aide/api test:integration`

Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/tests apps/api/vitest.integration.config.ts apps/api/package.json pnpm-lock.yaml
git commit -m "test(api): add integration test for session-reading auth plugin"
```

---

### Task 31: Register OAuth apps and fill `.env`

**Files:** none (operator task)

- [ ] **Step 1: Create a Google OAuth client**

Go to https://console.cloud.google.com/apis/credentials → Create Credentials → OAuth client ID → Web application.

Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`.

Copy client ID + secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

- [ ] **Step 2: Create a GitHub OAuth app**

Go to https://github.com/settings/developers → New OAuth App.

Authorization callback URL: `http://localhost:3000/api/auth/callback/github`.

Copy client ID + secret into `.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

- [ ] **Step 3: Generate an AUTH_SECRET**

Run: `openssl rand -base64 48` → paste into `.env` as `AUTH_SECRET`.

- [ ] **Step 4: Set remaining `.env` values**

```
NODE_ENV=development
DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide
NEXTAUTH_URL=http://localhost:3000
BOOTSTRAP_SUPER_ADMIN_EMAIL=<your real email that you'll use to log in>
BOOTSTRAP_DEFAULT_ORG_SLUG=demo
BOOTSTRAP_DEFAULT_ORG_NAME=Demo Org
LOG_LEVEL=info
```

**Do not commit `.env`.**

---

### Task 32: Manual end-to-end login verification

**Files:** none (verification task)

- [ ] **Step 1: Clean DB state**

```bash
docker compose -f docker/docker-compose.dev.yml down -v
docker compose -f docker/docker-compose.dev.yml up -d postgres
pnpm --filter @aide/db db:migrate
# Do NOT run seed — we want to exercise the bootstrap path
```

- [ ] **Step 2: Start web and api in two terminals**

Terminal A: `pnpm --filter @aide/api dev`
Terminal B: `pnpm --filter @aide/web dev`

- [ ] **Step 3: Open browser → http://localhost:3000**

Expected: redirected to `/sign-in`.

- [ ] **Step 4: Click "Sign in with Google"**

Sign in with the email that matches `BOOTSTRAP_SUPER_ADMIN_EMAIL`.

Expected: redirected to `/dashboard` and see `Signed in as <your-email>`.

- [ ] **Step 5: Confirm DB state**

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U aide -d aide -c \
  "select u.email, ra.role, ra.scope_type, o.slug from users u
     left join role_assignments ra on ra.user_id = u.id
     left join organizations o on o.slug = 'demo';"
```

Expected: your email + `super_admin | global` + `demo` org row.

- [ ] **Step 6: Sign out via dashboard button**

Expected: redirected to `/sign-in`.

- [ ] **Step 7: Try signing in with a DIFFERENT Google account (not the admin email)**

Expected: login fails; UI shows the NextAuth error page. DB has no new users.

- [ ] **Step 8: Sign back in with the admin email**

Expected: the existing user row is re-linked (no duplicates); dashboard loads.

No commit (verification only). If any step fails, fix the implementation and re-verify before proceeding.

---

### Task 33: Plan 1 acceptance checklist

**Files:** none

Verify all of the following are true before calling Plan 1 done:

- [ ] `pnpm install` on a fresh clone succeeds
- [ ] `pnpm turbo run typecheck` green across all workspaces
- [ ] `pnpm turbo run test` green across all workspaces (unit + integration)
- [ ] `docker compose -f docker/docker-compose.dev.yml up -d postgres` followed by `pnpm --filter @aide/db db:migrate` creates all 10 tables
- [ ] `pnpm --filter @aide/db db:seed` is idempotent and writes the super_admin row when run with env set
- [ ] `pnpm --filter @aide/api dev` serves `/health` returning `{"status":"ok",...}`
- [ ] `pnpm --filter @aide/web dev` serves `/sign-in`, `/dashboard`, `/api/auth/*`
- [ ] Google OAuth completes end-to-end, creates `users` + `accounts` + `sessions` rows, writes `role_assignments(super_admin, global)` and a `demo` org row via bootstrap path
- [ ] GitHub OAuth also completes (re-uses existing user by email)
- [ ] Non-admin Google email is rejected at `signIn` callback; no `users` row is created
- [ ] CI workflow passes on the feature branch

When all boxes are ticked, tag:

```bash
git tag v0.2.0-plan1
git push --tags
```

and proceed to Plan 2 (RBAC + API routers).

---

## Self-Review

| Check | Status |
|---|---|
| Spec §1 scope (monorepo, schema, OAuth, RBAC) | RBAC deferred to Plan 2 by design — documented in header |
| Spec §2.2 monorepo layout | Tasks 1, 4, 5, 6, 7, 8 cover every directory |
| Spec §2.3 tech choices | All pinned in Task dependencies (Next 15, Fastify 5, Drizzle, NextAuth beta.25, Postgres 16) |
| Spec §3 data model (10 tables) | Tasks 12–17 create every table; Task 18 generates migration; Task 21 round-trips |
| Spec §4.2 OAuth login flow | Tasks 23, 25, 26, 27, 28 implement; Task 32 verifies manually |
| Spec §4.3 session strategy (DB, 30 days) | Task 25 sets `strategy: 'database', maxAge: 30*24*60*60` |
| Spec §4.4 invite-only rules | Task 24 implements `decideSignUp`; Task 25 consumes it in signIn/createUser |
| Spec §4.6 Fastify session verification | Tasks 29–30 |
| Spec §4.8 security (AUTH_SECRET ≥32, rate limit) | AUTH_SECRET enforced in Task 3; rate limit deferred to Plan 2 alongside API surfaces |
| Spec §6.3 REST health endpoints | Task 7 |
| Spec §7.2 dev compose | Task 10 |
| Spec §7.5 env validation | Task 3 |
| Spec §8 testing strategy | Unit (Task 3, 24), integration (Task 21, 30) |
| Spec §11 risks — bootstrap misuse | Task 24 enforces email match; Task 32 step 7 verifies rejection |
| Placeholders | None — every task has full code or explicit skip note |
| Type consistency | `Database`, `BootstrapConfig`, `AuthEnv`, `ServerEnv` names consistent across tasks |
| Coverage gaps | Rate limiting on `/api/auth/*` is deferred (matches spec §4.8 but not in this plan scope); flagged in Plan 2 |

No blocking issues found. Plan is ready for execution.

