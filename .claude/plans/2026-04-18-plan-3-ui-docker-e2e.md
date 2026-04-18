# UI + Docker + Release Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working Web UI for org admins, a reproducible Docker image pair, CI-driven release pipeline, and 5 Playwright end-to-end flows — completing the `v0.2.0` MVP of the aide platform.

**Architecture:** `apps/web` gains tRPC client + shadcn/ui + App-Router pages backed by Plan 2 routers. `docker/Dockerfile.{api,web}` produce multi-stage images; `docker/docker-compose.yml` orchestrates Postgres + migrate + api + web for self-host. A tag-triggered GitHub Actions workflow publishes images to `ghcr.io`. Playwright covers the 5 spec flows with a mocked OAuth provider.

**Tech Stack:** Next.js 15 App Router + React 19 + Tailwind + shadcn/ui; `@trpc/client` + `@trpc/react-query` + `@tanstack/react-query` v5; Playwright 1.49; Docker 27; GitHub Actions with ghcr.io.

**Covers spec milestones:** M6 (Web UI) + M7 (Docker + release) + M8 (E2E acceptance).

**Reference spec:** `.claude/plans/2026-04-17-foundation-auth-design.md` §7 (deployment), §8 (testing).

**Pre-requisites:** Plan 2 merged. All 8 tRPC routers in place. Local dev stack (`docker compose -f docker/docker-compose.dev.yml up postgres` + `pnpm --filter @aide/web dev` + `pnpm --filter @aide/api dev`) works end-to-end.

---

## File Structure

```
apps/web/
├── src/
│   ├── lib/
│   │   ├── trpc/                    CREATE
│   │   │   ├── client.ts            React client + ReactQuery provider
│   │   │   ├── server.ts            Server-side caller (RSC)
│   │   │   └── Provider.tsx         client-side wrapper
│   │   └── format.ts                CREATE  date, email formatters
│   ├── components/                  CREATE
│   │   ├── ui/                      shadcn/ui primitives (button, input, dialog...)
│   │   ├── nav/                     Sidebar + topbar
│   │   ├── guards/                  RequirePerm wrapper
│   │   ├── forms/                   Org/Team/Dept/Invite forms
│   │   └── tables/                  DataTable wrapper
│   └── app/
│       ├── providers.tsx            MODIFY  TrpcProvider + SessionProvider
│       ├── layout.tsx               MODIFY  use new providers
│       ├── dashboard/
│       │   ├── page.tsx             MODIFY  real dashboard
│       │   ├── layout.tsx           CREATE  sidebar nav
│       │   ├── organizations/
│       │   │   ├── page.tsx         list
│       │   │   ├── new/page.tsx     create (super_admin only)
│       │   │   └── [id]/
│       │   │       ├── page.tsx     overview
│       │   │       ├── departments/page.tsx
│       │   │       ├── teams/page.tsx
│       │   │       ├── members/page.tsx
│       │   │       ├── invites/page.tsx
│       │   │       └── audit/page.tsx
│       │   ├── teams/[id]/page.tsx  team detail + member mgmt
│       │   └── profile/page.tsx     me.updateProfile
│       ├── auth/
│       │   └── error/page.tsx       CREATE  friendly OAuth error UI
│       ├── not-found.tsx            CREATE  fixes Next.js prerender
│       └── error.tsx                CREATE  app-level error boundary
├── tailwind.config.ts               CREATE
├── postcss.config.mjs               CREATE
├── components.json                  CREATE (shadcn config)
└── e2e/                             CREATE
    ├── playwright.config.ts
    ├── fixtures/
    │   ├── mock-oauth.ts            intercepts Google OAuth during tests
    │   └── seed-db.ts               CLI to reset DB for each run
    └── specs/
        ├── 01-signin.spec.ts
        ├── 02-invite-accept.spec.ts
        ├── 03-team-crud.spec.ts
        ├── 04-rbac-member-forbidden.spec.ts
        └── 05-audit-log.spec.ts

docker/
├── Dockerfile.api                   CREATE
├── Dockerfile.web                   CREATE
├── docker-compose.yml               CREATE  production stack
└── docker-compose.dev.yml           (existing — unchanged)

.github/workflows/
├── ci.yml                           MODIFY  add Playwright job
└── release.yml                      CREATE  tag-triggered docker publish

docs/
└── SELF_HOSTING.md                  CREATE  setup/update/backup guide
```

---

## Phase A: Web UI Foundation (Tasks 1–6)

### Task 1: Tailwind + shadcn/ui setup

**Files:**
- Create: `apps/web/tailwind.config.ts`, `postcss.config.mjs`, `components.json`
- Create: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/layout.tsx`
- Install: tailwindcss, postcss, autoprefixer, clsx, class-variance-authority, tailwind-merge, lucide-react, @radix-ui/react-* primitives

- [ ] **Step 1: Install deps**

```bash
pnpm --filter @aide/web add tailwindcss@^4 @tailwindcss/postcss clsx class-variance-authority tailwind-merge lucide-react
pnpm --filter @aide/web add @radix-ui/react-dialog @radix-ui/react-label @radix-ui/react-slot @radix-ui/react-dropdown-menu
```

- [ ] **Step 2: Init shadcn**

```bash
pnpm --filter @aide/web dlx shadcn@latest init -d
```

Accept defaults: style=default, base color=slate, CSS variables=yes.

- [ ] **Step 3: Add baseline UI primitives**

```bash
pnpm --filter @aide/web dlx shadcn@latest add button input label card dialog dropdown-menu form table sonner
```

- [ ] **Step 4: Modify `apps/web/src/app/layout.tsx`**

```typescript
import type { ReactNode } from 'react'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

export const metadata = {
  title: 'aide',
  description: 'AI Development Performance Evaluator'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Verify build**

```bash
pnpm --filter @aide/web build
```

Expected: build succeeds, tailwind classes resolved.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add Tailwind + shadcn/ui primitives"
```

---

### Task 2: tRPC client + provider

**Files:**
- Create: `apps/web/src/lib/trpc/client.ts`, `server.ts`, `Provider.tsx`
- Create: `apps/web/src/app/providers.tsx`
- Modify: `apps/web/src/app/layout.tsx`

- [ ] **Step 1: Install tRPC client + React Query**

```bash
pnpm --filter @aide/web add @trpc/client@^11 @trpc/server@^11 @trpc/react-query@^11 @tanstack/react-query@^5 superjson
```

- [ ] **Step 2: Create `apps/web/src/lib/trpc/client.ts`**

```typescript
'use client'
import { createTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '../../../../api/src/trpc/router'

export const trpc = createTRPCReact<AppRouter>()
```

> Note: the cross-package type import is deliberate — keeps client fully typed without publishing `@aide/api` as a package. Adjust path if workspace layout moves.

- [ ] **Step 3: Create `apps/web/src/lib/trpc/Provider.tsx`**

```typescript
'use client'
import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { trpc } from './client'

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url:
            typeof window === 'undefined'
              ? `${process.env.API_URL ?? 'http://api:3001'}/trpc`
              : '/api/trpc',
          transformer: superjson
        })
      ]
    })
  )
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
```

- [ ] **Step 4: Create `apps/web/src/lib/trpc/server.ts`** (RSC caller)

```typescript
import 'server-only'
import { headers, cookies } from 'next/headers'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../../../../api/src/trpc/router'
import { getEnv } from '../../env'

export async function serverTrpc() {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${getEnv().API_INTERNAL_URL ?? 'http://api:3001'}/trpc`,
        transformer: superjson,
        headers: () => ({ cookie: cookieHeader })
      })
    ]
  })
}
```

> `API_INTERNAL_URL` is a new env — add to `packages/config/src/env.ts`. Default to `http://api:3001`; dev overrides to `http://localhost:3001`.

- [ ] **Step 5: Add Next proxy route for `/api/trpc`**

Create `apps/web/src/app/api/trpc/[trpc]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getEnv } from '@/env'

export async function GET(req: NextRequest) {
  return proxy(req)
}
export async function POST(req: NextRequest) {
  return proxy(req)
}

async function proxy(req: NextRequest): Promise<NextResponse> {
  const env = getEnv()
  const upstream = `${env.API_INTERNAL_URL}/trpc${req.nextUrl.pathname.replace(/^\/api\/trpc/, '')}${req.nextUrl.search}`
  const res = await fetch(upstream, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    redirect: 'manual'
  })
  return new NextResponse(res.body, { status: res.status, headers: res.headers })
}
```

- [ ] **Step 6: Create `apps/web/src/app/providers.tsx`** and wire into layout

```typescript
'use client'
import { TrpcProvider } from '@/lib/trpc/Provider'
export function Providers({ children }: { children: React.ReactNode }) {
  return <TrpcProvider>{children}</TrpcProvider>
}
```

Modify `layout.tsx` to wrap `{children}` in `<Providers>`.

- [ ] **Step 7: Commit**

```bash
git add apps/web packages/config pnpm-lock.yaml
git commit -m "feat(web): wire tRPC client (RSC + React Query) through Next proxy"
```

---

### Task 3: Dashboard layout + navigation

**Files:**
- Create: `apps/web/src/app/dashboard/layout.tsx`
- Create: `apps/web/src/components/nav/Sidebar.tsx`, `Topbar.tsx`
- Modify: `apps/web/src/app/dashboard/page.tsx`

- [ ] **Step 1: Implement Sidebar with nav items gated by session**

Key items (conditional on permissions from `me.session`):
- Dashboard (all)
- Organizations (if `coveredOrgs.size > 0`)
- Teams (if `coveredTeams.size > 0`)
- Invites (org_admin+ at any org)
- Audit Log (org_admin+ at any org)
- Profile (all)

- [ ] **Step 2: Dashboard page shows session summary**

Real dashboard content:
- Welcome header with user name
- Coverage cards: # of orgs, depts, teams accessible
- Role badges
- Recent audit entries (if visible)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add dashboard layout, sidebar nav, session summary"
```

---

### Task 4: Organizations list & detail

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/page.tsx` (list)
- Create: `apps/web/src/app/dashboard/organizations/new/page.tsx` (create, super_admin only)
- Create: `apps/web/src/app/dashboard/organizations/[id]/page.tsx` (overview)
- Create: `apps/web/src/app/dashboard/organizations/[id]/layout.tsx` (tab nav)
- Create: `apps/web/src/components/forms/OrgForm.tsx`
- Create: `apps/web/src/components/guards/RequireRole.tsx`

- [ ] **Step 1: Organizations list — uses `trpc.organizations.list.useQuery()`**

Shows a table with columns: slug, name, created_at, action buttons (View, Edit if permitted).

Example:
```typescript
'use client'
import Link from 'next/link'
import { trpc } from '@/lib/trpc/client'
import { Button } from '@/components/ui/button'

export default function OrganizationsListPage() {
  const { data, isLoading } = trpc.organizations.list.useQuery()
  if (isLoading) return <div>Loading…</div>
  if (!data?.length) return <div>No organizations visible.</div>
  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <h1 className="text-2xl font-semibold">Organizations</h1>
        <Button asChild><Link href="/dashboard/organizations/new">New</Link></Button>
      </div>
      <table className="w-full text-sm">
        <thead><tr><th>Slug</th><th>Name</th><th></th></tr></thead>
        <tbody>
          {data.map((o) => (
            <tr key={o.id}>
              <td>{o.slug}</td>
              <td>{o.name}</td>
              <td><Link href={`/dashboard/organizations/${o.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Create form — uses `trpc.organizations.create.useMutation()`**

Uses `react-hook-form` + zod resolver. On success: toast + navigate. On error: display `data.code === 'FORBIDDEN'` message.

- [ ] **Step 3: `[id]/layout.tsx` — tabs: Overview / Depts / Teams / Members / Invites / Audit**

Tab visibility per permission:
- Depts/Teams: `coveredOrgs.has(id)`
- Members: `rolesByOrg.get(id)?.has('org_admin' | 'dept_manager' | 'team_manager')` or any covered team in this org
- Invites: `rolesByOrg.get(id)?.has('org_admin')` or any dept_manager/team_manager in this org
- Audit: `rolesByOrg.get(id)?.has('org_admin')` or any dept_manager in this org

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add organizations list, create, detail layout"
```

---

### Task 5: Departments + Teams CRUD pages

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/departments/page.tsx`
- Create: `apps/web/src/app/dashboard/organizations/[id]/teams/page.tsx`
- Create: `apps/web/src/app/dashboard/teams/[id]/page.tsx`
- Create: `apps/web/src/components/forms/DeptForm.tsx`, `TeamForm.tsx`

Departments page:
- List filtered by `orgId`
- "New Department" button (only for org_admin of this org or super_admin)
- Each row: name / slug / # teams / actions (edit, delete)

Teams page:
- List filtered by `orgId`, with optional department filter
- "New Team" button
- Each row: name / slug / department / action (Open → `/dashboard/teams/[id]`)

Team detail page (`/dashboard/teams/[id]`):
- Overview
- Members list with `trpc.users.list({ teamId })`
- Add Member: search user by email, call `trpc.teams.addMember`
- Remove Member: call `trpc.teams.removeMember`

- [ ] **Step 1: Build departments page**

- [ ] **Step 2: Build teams page**

- [ ] **Step 3: Build team detail page with member management**

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add dept/team CRUD pages and team detail with member mgmt"
```

---

### Task 6: Invites + Audit + Profile pages

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/invites/page.tsx`
- Create: `apps/web/src/app/dashboard/organizations/[id]/members/page.tsx`
- Create: `apps/web/src/app/dashboard/organizations/[id]/audit/page.tsx`
- Create: `apps/web/src/app/dashboard/profile/page.tsx`
- Create: `apps/web/src/app/invite/[token]/page.tsx` (accept invite landing)

Invites page:
- List pending invites via `trpc.invites.list({ orgId })`
- "New Invite" dialog: email + role + scope selector
- On create: show generated link `https://<host>/invite/<token>` with copy button
- "Revoke" action per row

Members page (`/members`):
- List users visible within org + their roles at various scopes
- Per row: Grant Role / Revoke Role actions

Audit page:
- Table of `trpc.auditLogs.list({ orgId, since, until, action, actorId, limit })`
- Filters: date range, action type, actor
- Pagination via cursor (future)

Profile page:
- Show current user info + assignments
- Editable: name, image (via `trpc.me.updateProfile`)

Invite accept page (`/invite/[token]`):
- If not signed in: redirect to `/sign-in?returnTo=/invite/<token>`
- If signed in: call `trpc.invites.accept({ token })` → toast + redirect to org

- [ ] **Step 1: Build invites page + accept landing**

- [ ] **Step 2: Build members page**

- [ ] **Step 3: Build audit page**

- [ ] **Step 4: Build profile page**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add invites, members, audit, profile pages"
```

---

## Phase B: UX polish (Tasks 7–10)

### Task 7: Sign-in error messages

**Files:**
- Create: `apps/web/src/app/auth/error/page.tsx`
- Modify: `apps/web/src/app/sign-in/page.tsx`

Error page renders from `?error=<code>`:
- `AccessDenied` → "You do not have permission. Contact an administrator for an invitation."
- `OAuthAccountNotLinked` → "This email is already linked to another sign-in method. Use that provider, or link accounts from your profile."
- `Configuration` → "Server misconfigured. Contact the administrator."

Sign-in page reads the `?error` query param and shows a banner above the buttons on retry.

- [ ] Commit: `feat(web): friendly sign-in error UX`

---

### Task 8: Fix Next.js prerender — not-found + error boundaries

**Files:**
- Create: `apps/web/src/app/not-found.tsx`
- Create: `apps/web/src/app/error.tsx`
- Create: `apps/web/src/app/global-error.tsx`

`not-found.tsx`:
```typescript
import Link from 'next/link'
export default function NotFound() {
  return (
    <main className="p-6">
      <h1 className="text-2xl">Page not found</h1>
      <p><Link href="/dashboard">Back to dashboard</Link></p>
    </main>
  )
}
```

`error.tsx` (must be client):
```typescript
'use client'
export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="p-6">
      <h1 className="text-2xl">Something went wrong</h1>
      <pre className="text-xs">{error.message}</pre>
      <button onClick={reset} className="mt-4 underline">Try again</button>
    </main>
  )
}
```

- [ ] Commit: `fix(web): add not-found + error boundaries to complete static prerender`

---

### Task 9: RequirePerm UI guard

**Files:**
- Create: `apps/web/src/components/guards/RequirePerm.tsx`
- Create: `apps/web/src/lib/use-permissions.ts`

`usePermissions()` — thin wrapper on `trpc.me.session.useQuery()` that returns `{ perm, canReadAuditIn(orgId), canManageOrg(orgId), ... }`.

`<RequirePerm check={(p) => p.canManageOrg(orgId)}>...</RequirePerm>` — renders children only if check passes; otherwise renders null (or a `forbidden` slot).

All mutation buttons use this guard. Server-side routers still enforce authoritatively.

- [ ] Commit: `feat(web): add RequirePerm client guard + usePermissions hook`

---

### Task 10: E2E-ready seeding endpoint

**Files:**
- Create: `apps/api/src/rest/test-seed.ts` (only mounts when `NODE_ENV=test`)

POST `/test-seed` accepts a JSON payload describing orgs/teams/users/sessions and inserts them. The endpoint **404s outside `NODE_ENV=test`**.

This is only used by Playwright tests to set known state quickly.

- [ ] Commit: `feat(api): add /test-seed route (test env only) for E2E setup`

---

## Phase C: Docker + Release (Tasks 11–16)

### Task 11: Dockerfile.api

**File:** `docker/Dockerfile.api`

Multi-stage: `deps` (install via pnpm with corepack) → `build` (workspace turbo build) → `runtime` (node:20-alpine, only `dist/` + production deps).

Key details:
- `pnpm deploy --filter=@aide/api --prod ./dist` to get a standalone deploy folder
- `ENV NODE_ENV=production`, expose port 3001, `HEALTHCHECK CMD wget -qO- http://localhost:3001/health`
- `CMD ["node", "dist/server.js"]`

Build locally:
```bash
docker build -f docker/Dockerfile.api -t aide-api:local .
docker run --rm -p 3001:3001 --env-file .env aide-api:local
```

- [ ] Commit: `feat(docker): multi-stage Dockerfile.api`

---

### Task 12: Dockerfile.web

**File:** `docker/Dockerfile.web`

Uses Next.js standalone output. Three stages similar to api. `ENV NEXT_TELEMETRY_DISABLED=1`. `EXPOSE 3000`, `CMD ["node", "apps/web/server.js"]`.

Notes:
- `next.config.mjs` already sets `output: 'standalone'`
- Copy `.next/standalone/`, `.next/static/`, and `public/` into the runtime stage

- [ ] Commit: `feat(docker): multi-stage Dockerfile.web`

---

### Task 13: Production docker-compose.yml

**File:** `docker/docker-compose.yml`

Services:
1. `postgres` (postgres:16-alpine, persistent volume, healthcheck)
2. `migrate` (image: ghcr.io/hanfour/aide-api:${VERSION}, command: node dist/migrate.js, depends_on postgres healthy)
3. `api` (image: aide-api, depends_on migrate completed, 3001, healthcheck)
4. `web` (image: aide-web, depends_on api healthy, 3000)

Env from `.env`:
```
VERSION=v0.2.0
DB_USER / DB_PASSWORD / DB_NAME
AUTH_SECRET / NEXTAUTH_URL / OAuth secrets
BOOTSTRAP_SUPER_ADMIN_EMAIL / BOOTSTRAP_DEFAULT_ORG_SLUG / BOOTSTRAP_DEFAULT_ORG_NAME
```

Validate locally:
```bash
export VERSION=local
docker build -f docker/Dockerfile.api -t ghcr.io/hanfour/aide-api:local .
docker build -f docker/Dockerfile.web -t ghcr.io/hanfour/aide-web:local .
docker compose -f docker/docker-compose.yml up
```

- [ ] Commit: `feat(docker): production compose stack with migrate + healthchecks`

---

### Task 14: release.yml — tag-triggered image publish

**File:** `.github/workflows/release.yml`

Triggers on tag push matching `v*`. Jobs:
1. `build-and-push` with matrix `[api, web]`
2. Docker buildx, cache from/to GHA cache
3. Push `ghcr.io/hanfour/aide-{image}:${tag}` and `:latest`
4. Create GitHub Release with auto-generated notes

```yaml
name: Release
on:
  push:
    tags: [v*]
jobs:
  docker:
    strategy:
      matrix:
        image: [api, web]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile.${{ matrix.image }}
          push: true
          tags: |
            ghcr.io/hanfour/aide-${{ matrix.image }}:${{ github.ref_name }}
            ghcr.io/hanfour/aide-${{ matrix.image }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
  release:
    needs: docker
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] Commit: `ci: add tag-triggered release workflow`

---

### Task 15: Self-hosting documentation

**File:** `docs/SELF_HOSTING.md`

Sections:
1. Prerequisites (Docker 27+, domain, OAuth apps registered)
2. `.env` setup (point at `.env.example`, `openssl rand -base64 48` for `AUTH_SECRET`)
3. First run: `docker compose up` — creates tables, waits for admin email sign-in
4. Updating: `docker compose pull && docker compose up -d`
5. Backup: `pg_dump` example
6. Troubleshooting: common OAuth redirect URL mistakes, `/health/ready` returning 503, Auth.js `OAuthAccountNotLinked`

- [ ] Commit: `docs: add SELF_HOSTING.md guide`

---

### Task 16: `/health/ready` + `/health` return real DB state

**Files:**
- Modify: `apps/api/src/rest/health.ts`

`GET /health` returns `{ status: 'ok', version, db: 'up' | 'down' }` — tries `select 1` from the pool; `db: 'up'` only if query succeeds.

`GET /health/ready` returns 200 when: DB reachable AND migrations applied (check `__drizzle_migrations` table exists and has rows). Else 503.

- [ ] Commit: `feat(api): real DB liveness + readiness probes`

---

## Phase D: Playwright E2E (Tasks 17–22)

### Task 17: Playwright install + config

**Files:**
- Create: `apps/web/e2e/playwright.config.ts`
- Create: `apps/web/e2e/fixtures/{seed-db,mock-oauth}.ts`
- Modify: `apps/web/package.json` (e2e scripts)

```bash
pnpm --filter @aide/web add -D @playwright/test
pnpm --filter @aide/web exec playwright install --with-deps chromium
```

`playwright.config.ts` uses `baseURL: http://localhost:3000`, `webServer` runs `pnpm --filter @aide/web dev` + api in parallel (use `npm-run-all` or two `webServer` entries).

OAuth is mocked: tests POST directly to `/test-seed` to create a user + session, set cookie, then navigate. No real Google redirect. This mirrors what `signInAsUser()` helper does in API tests.

- [ ] Commit: `test(web): add Playwright config + test-seed fixture`

---

### Task 18: E2E — sign-in flow (mocked OAuth)

**File:** `apps/web/e2e/specs/01-signin.spec.ts`

Scenario:
1. Reset DB via `/test-seed` with super_admin seeded
2. Hit `/sign-in`
3. Set session cookie directly (bypass OAuth)
4. Navigate `/dashboard`
5. Expect "Signed in as <email>" visible
6. Click Sign Out, expect redirect back to `/sign-in` and DB session row gone

- [ ] Commit: `test(web): E2E sign-in and sign-out`

---

### Task 19: E2E — invite + accept

**File:** `apps/web/e2e/specs/02-invite-accept.spec.ts`

1. Seed org_admin + empty org
2. Sign in as org_admin
3. Navigate to `/dashboard/organizations/[id]/invites`
4. Fill form: email=`invitee@test`, role=`member`, scope=`organization`
5. Capture generated invite URL from UI
6. Sign out
7. Seed `invitee@test` user + session (as if they signed in)
8. Visit invite URL
9. Expect redirect to org overview; assert role assignment in DB via API

- [ ] Commit: `test(web): E2E invite create + accept round trip`

---

### Task 20: E2E — team CRUD

**File:** `apps/web/e2e/specs/03-team-crud.spec.ts`

org_admin creates, renames, deletes a team through UI. After delete, list reflects it. Verify via API that team is soft-deleted.

- [ ] Commit: `test(web): E2E team CRUD`

---

### Task 21: E2E — RBAC member forbidden

**File:** `apps/web/e2e/specs/04-rbac-member-forbidden.spec.ts`

Seed a member-role user. Visit `/dashboard/organizations/<id>/teams/new` — expect either button not rendered (UI guard) or 403 response if hit directly.

Also test: API mutation as that user returns FORBIDDEN (via `trpc` call).

- [ ] Commit: `test(web): E2E RBAC rejects member-role creation attempts`

---

### Task 22: E2E — audit log visibility

**File:** `apps/web/e2e/specs/05-audit-log.spec.ts`

1. Seed org_admin + invitee pair
2. Sign in as org_admin, create an invite
3. Visit `/dashboard/organizations/<id>/audit`
4. Expect a row with action `invite.created`, actor=org_admin, target=invite id, within last 10 seconds

- [ ] Commit: `test(web): E2E audit log reflects org_admin actions`

---

### Task 23: Wire Playwright into CI

**File:** `.github/workflows/ci.yml`

Add a third job `e2e`:
1. Check out, pnpm install
2. Start postgres (service container)
3. Migrate + seed
4. Build api + web
5. `pnpm --filter @aide/web exec playwright install --with-deps chromium`
6. Run api + web in background
7. `pnpm --filter @aide/web exec playwright test`
8. Upload Playwright report as artifact on failure

- [ ] Commit: `ci: add e2e job running Playwright on Chromium`

---

## Phase E: Acceptance + v0.2.0 Release (Tasks 24–25)

### Task 24: Full DoD verification

Run through the Plan 1 Definition-of-Done items that were previously deferred:

- [ ] super_admin can create org / dept / team, invite a user, and grant a role — **via UI**, not just API
- [ ] Each of the 5 roles enforces the RBAC matrix for representative actions — covered by router tests + E2E
- [ ] `/health` returns `{ status: 'ok', db: 'up' }` — Task 16
- [ ] `/docs` Swagger reachable in dev; disabled by default in prod — deferred to v0.3 unless trivial
- [ ] CI workflows `ci`, `release`, `e2e` green
- [ ] Docker images `ghcr.io/hanfour/aide-api:v0.2.0` + `aide-web:v0.2.0` pullable
- [ ] All 5 Playwright E2E flows pass
- [ ] Coverage ≥ 80% overall; `packages/auth` ≥ 95% (revisit threshold)

Manual acceptance:
1. Pull images, `docker compose up` on a clean VPS-like environment (can use local Docker)
2. Open `https://<host>/`, sign in with real Google OAuth
3. Bootstrap super_admin → demo org created
4. Invite a second user via UI → they sign in → land on dashboard with member role
5. Sign-out flows work

- [ ] Commit: `docs: Plan 3 acceptance notes` (if any discrepancies recorded)

---

### Task 25: Tag v0.2.0 + announce

```bash
# from main after Plan 3 merged
git tag v0.2.0
git push origin v0.2.0
```

Release workflow publishes images + creates GitHub Release with auto-generated notes.

Update `README.md`:
- Add "Platform mode" section (beside CLI mode)
- Link to `docs/SELF_HOSTING.md`
- Demo screenshot (optional)

- [ ] Commit: `docs(readme): document platform mode and link to self-hosting guide`

---

## Self-Review

| Spec requirement | Task |
|---|---|
| §6 Web UI for org_admin CRUD | Tasks 3–6 |
| §7.1 Dockerfile.api + Dockerfile.web (multi-stage) | Tasks 11, 12 |
| §7.3 Production compose with migrate step | Task 13 |
| §7.6 release.yml on tag push | Task 14 |
| §7.7 `docker compose pull && up -d` upgrade flow | Task 15 (documented) |
| §4.8 sign-in error UX | Task 7 |
| §8.7 5 Playwright flows | Tasks 18–22 |
| §8.8 CI includes playwright | Task 23 |
| §11 risks — Next prerender quirk | Task 8 (not-found + error boundaries) |
| §14 Definition-of-Done verification | Task 24 |

**Placeholder scan:** Tasks 3, 4, 5, 6, 7, 9 use structure + representative code rather than full verbatim files because UI has design latitude. The engineer implementing Plan 3 is expected to pick consistent UI patterns (shadcn Table vs custom, cards vs rows) once — flag any divergence during review.

**Type consistency:** Uses `AppRouter` type imported across client/server, consistent `orgId`/`teamId`/`deptId` naming matching Plan 2 routers.

**Known loose edges:**

- Task 2 cross-workspace import (`apps/web → apps/api/src/trpc/router`) is unusual. Alternative: move the router into `packages/api-shared` that both import. Plan 3 keeps it simple; reconsider if IDE complains or builds break.
- Task 10 (`/test-seed`) is an attack surface if ever enabled in prod. Gated strictly on `NODE_ENV=test`; ensure CI does not accidentally leak the `NODE_ENV` into release images (verified via Dockerfile `ENV NODE_ENV=production`).
- Task 18–22 E2E test fixtures assume a single Playwright test worker. For parallelism, DB isolation per worker (either per-test DB or per-test transaction) is deferred.

No spec requirement is uncovered.
