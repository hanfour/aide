# Design: Foundation + Auth & Organization Model

- **Spec date:** 2026-04-17
- **Author:** hanfourhuang
- **Scope:** First sub-project of the larger "aide platform transformation" (C direction — full-featured self-hosted platform)
- **Covers sub-projects:** ① 基礎設施 · ② 認證與組織模型
- **Status:** Draft, awaiting user review

---

## 1. Background & Context

### 1.1 Current state

`aide` is a TypeScript CLI tool that reads local Claude Code (`~/.claude/`) and Codex (`~/.codex/`) data and produces an evaluation report. It runs entirely on a single engineer's machine; there is no server, no shared storage, no multi-user concept.

### 1.2 Target state (long term)

Transform `aide` into a self-hostable, open-source platform — analogous to `sub2api` but for **engineering performance evaluation**, not API gateway/cost sharing. The platform must let an engineering manager view aggregated AI-usage-based evaluations for their team, department, and organization.

### 1.3 Why decompose

The full platform spans ~10 independent subsystems (infra, auth, ingestion, storage, evaluation engine, standard management, web UI, advanced reports, audit, ops hardening). Each must have its own spec → plan → implementation cycle. This document only covers the **first two** — foundation and auth.

### 1.4 This spec's boundaries

**In scope:**
- Monorepo structure (pnpm workspaces + Turborepo)
- Database schema for organizations, departments, teams, users, roles, invites, audit logs, and Auth.js tables
- OAuth authentication (Google, GitHub) via Auth.js v5
- Role-based access control with five roles × four scope levels
- Fastify + tRPC + REST API skeleton, with health routes only
- Docker Compose for dev and prod self-host
- CI/CD pipelines (GitHub Actions)
- Testing strategy (unit, integration, E2E)

**Out of scope (future sub-projects):**
- Data ingestion (CLI sync, hook upload)
- Raw data storage pipeline
- Evaluation engine (server-side `packages/core` integration)
- Evaluation standard Web UI CRUD
- Report UI (dashboards, charts, export)
- Email sending (invites produce copy-paste links only in MVP)
- SAML / OIDC enterprise SSO
- Email + Password auth
- K8s Helm, HA, backup automation

---

## 2. Architecture

### 2.1 High-level components

```
┌────────────────────────────────────────────────────────┐
│                   Browser (Web UI)                     │
└───────────────┬────────────────────────────────────────┘
                │ HTTPS
                ▼
┌────────────────────────────────────────────────────────┐
│  apps/web  (Next.js 15 App Router)                     │
│  ├─ Auth.js v5 (Google + GitHub OAuth)                 │
│  ├─ tRPC client                                        │
│  └─ Route handlers → proxy to apps/api                 │
└───────────────┬────────────────────────────────────────┘
                │ tRPC over HTTP
                ▼
┌────────────────────────────────────────────────────────┐
│  apps/api  (Fastify + tRPC + REST)                     │
│  ├─ tRPC routers (web-facing)                          │
│  ├─ REST routes (health; future ingest/agent stubs)    │
│  ├─ Auth middleware (reads Auth.js session)            │
│  └─ RBAC middleware (scope resolution + `can()`)       │
└───────────────┬────────────────────────────────────────┘
                │ Drizzle ORM
                ▼
┌────────────────────────────────────────────────────────┐
│  PostgreSQL 16                                         │
└────────────────────────────────────────────────────────┘
```

### 2.2 Monorepo layout

```
aide/
├── apps/
│   ├── cli/              # Existing aide CLI (unchanged in this spec)
│   ├── api/              # New: Fastify + tRPC backend
│   └── web/              # New: Next.js 15 frontend
├── packages/
│   ├── core/             # Skeleton only; existing src/ migrates later
│   ├── db/               # New: Drizzle schema + migrations
│   ├── auth/             # New: Auth.js config + RBAC utilities
│   └── config/           # New: shared env validation, constants
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   ├── docker-compose.yml
│   └── docker-compose.dev.yml
├── .github/workflows/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

The existing `src/`, `tests/`, `templates/` remain untouched during this spec. Migrating them into `packages/core` is a future sub-project.

### 2.3 Locked technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js ≥ 20 LTS | Active LTS, native ESM |
| Package manager | pnpm ≥ 9 | Fast, disk-efficient, monorepo-first |
| Monorepo tool | Turborepo | Incremental builds, remote cache later |
| Frontend | Next.js 15 App Router | Most mature React + SSR + auth story |
| Backend HTTP | Fastify 4 | Mature, schema validation, plugin model, native pino |
| Web API style | tRPC v11 | End-to-end TypeScript types, no OpenAPI overhead for Web UI |
| Machine API style | REST + OpenAPI (skeleton only this spec) | Stable contract for CLI/agent integrations |
| ORM | Drizzle + drizzle-kit | Pure TS schema, SQL-first, lightweight, fast cold start |
| Database | PostgreSQL 16 | UUID v7 native, strong JSONB, wide hosting support |
| Auth | Auth.js v5 (NextAuth) | Native Next.js integration, DB session, adapter ecosystem |
| Validation | zod 3 | Shared runtime + static types |
| Testing | vitest (existing) + Playwright | Fast, compatible with current test suite |
| Logging | pino (Fastify-native) | Fast JSON logs, fits self-host |

---

## 3. Data Model

All schema lives under `packages/db/src/schema/`, split by domain.

### 3.1 Auth.js standard tables

Drizzle implementations of the four Auth.js tables, using the official `@auth/drizzle-adapter`:

```
users                  (id, email, name, image, email_verified, created_at)
accounts               (user_id, provider, provider_account_id, access_token, refresh_token, expires_at, token_type, scope, id_token, session_state)
sessions               (session_token PK, user_id, expires)
verification_tokens    (identifier, token, expires)
```

### 3.2 Organization hierarchy

```sql
organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
)

departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations,
  name            text NOT NULL,
  slug            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (org_id, slug)
)

teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations,
  department_id   uuid REFERENCES departments,       -- nullable (team may sit directly under org)
  parent_team_id  uuid REFERENCES teams,             -- nullable (MVP all null, reserved for future nesting)
  name            text NOT NULL,
  slug            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (org_id, slug)
)

team_members (
  team_id         uuid REFERENCES teams,
  user_id         uuid REFERENCES users,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
)

organization_members (
  org_id          uuid REFERENCES organizations,
  user_id         uuid REFERENCES users,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
)
```

### 3.3 Role assignments

```sql
role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL CHECK (role IN ('super_admin','org_admin','dept_manager','team_manager','member')),
  scope_type      text NOT NULL CHECK (scope_type IN ('global','organization','department','team')),
  scope_id        uuid,                              -- null for global
  granted_by      uuid REFERENCES users,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
)

CREATE INDEX idx_role_assignments_user_active ON role_assignments (user_id) WHERE revoked_at IS NULL;
```

`scope_id` is polymorphic — it refers to `organizations.id`, `departments.id`, or `teams.id` depending on `scope_type`. Integrity is enforced at the service layer, not with FKs.

### 3.4 Invites

```sql
invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations,
  email           text NOT NULL,
  role            text NOT NULL,
  scope_type      text NOT NULL,
  scope_id        uuid,
  invited_by      uuid NOT NULL REFERENCES users,
  expires_at      timestamptz NOT NULL,              -- default: now() + 7 days
  accepted_at     timestamptz,
  token           text UNIQUE NOT NULL,              -- URL-safe random, shown in copy link
  UNIQUE (org_id, email)
)
```

### 3.5 Audit logs

```sql
audit_logs (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES users,
  action          text NOT NULL,                     -- e.g. 'user.invited', 'role.granted'
  target_type     text,
  target_id       uuid,
  org_id          uuid,                              -- for tenant-scoped queries
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
)

CREATE INDEX idx_audit_logs_org_created ON audit_logs (org_id, created_at DESC);
```

### 3.6 Relationship diagram

```
organizations ──< departments ──< teams ──< team_members >── users
      │                              │                         │
      └──< organization_members >────┴─────< role_assignments >─┘
                                                │
                                          scope_id references
                                          organizations / departments / teams
                                          (polymorphic via scope_type)
```

### 3.7 Schema-level conventions

1. **PKs:** UUID (pg 16 `gen_random_uuid()`).
2. **Soft delete:** `deleted_at` column on org/dept/team; service layer filters.
3. **Slugs:** regex `/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/` enforced by zod and DB CHECK.
4. **Migrations:** drizzle-kit generates SQL; all migrations live at `packages/db/drizzle/` and are committed.
5. **Seed:** `pnpm db:seed` (dev/demo convenience) inserts a demo org and one `users` row + `role_assignments(super_admin, global)` for the email in `BOOTSTRAP_SUPER_ADMIN_EMAIL`. No `accounts` row is created; the OAuth link happens when that email first signs in. For production, skip seed and rely on the §4.4 row-3 bootstrap path instead.

---

## 4. Authentication

### 4.1 Auth.js v5 configuration

Location: `packages/auth/src/`.

```
packages/auth/src/
├── config.ts              # NextAuth config export
├── drizzle-adapter.ts     # @auth/drizzle-adapter wiring
├── providers.ts           # Google + GitHub provider definitions
└── rbac/
    ├── scope.ts           # Permission resolution
    └── check.ts           # can() function
```

Both `apps/web` and `apps/api` import `@aide/auth` to share session verification.

### 4.2 OAuth login flow

```
1. User clicks "Sign in with Google"
2. apps/web -> /api/auth/signin/google -> 302 to Google
3. Google auth callback -> /api/auth/callback/google
4. Auth.js:
   a. Find accounts row by (provider, providerAccountId)
      - Found   -> link to existing user
      - Missing -> look up user by email
          - User exists  -> link new account
          - User missing -> check invites table (see §4.4)
5. Insert sessions row (DB session, NOT JWT)
6. Set cookie: next-auth.session-token (httpOnly, sameSite=lax, secure in prod)
7. Redirect to /dashboard
```

### 4.3 Session strategy

| Attribute | Value | Rationale |
|---|---|---|
| Storage | DB (`sessions` table) | Revocable, auditable |
| TTL | 30 days, rolling | Reduces re-login friction, bounds token theft blast radius |
| Cookie | `httpOnly; sameSite=lax; secure (prod)` | XSS/CSRF defense |
| Content | session_token only | User data loaded from DB per request |

### 4.4 Invite-only registration

New users must be invited; this prevents arbitrary Google accounts from logging in.

**Sign-up decision table** (evaluated in order):

| # | Scenario | Action |
|---|---|---|
| 1 | Incoming email matches an existing `users` row (seeded or linked) | Link OAuth account to that user; no new membership or role rows created |
| 2 | Valid unexpired invite matches email | Create `users` + `organization_members` + `role_assignments`; mark invite accepted |
| 3 | No invite, system has zero users, **and** incoming email matches `BOOTSTRAP_SUPER_ADMIN_EMAIL` | Auto-promote: create user + `role_assignments(super_admin, global)`; create default org from `BOOTSTRAP_DEFAULT_ORG_SLUG` env |
| 4 | Any other case | Deny login; show "Contact an administrator for an invitation" page |

The bootstrap path (row 3) is only reachable on a fresh install. Once any user exists — whether from seed or a prior sign-up — row 3 is dead, and all further registrations must come through row 2 (invite).

**Invite flow:** org_admin enters email + role/scope in UI → system generates invite token → UI shows copy-to-clipboard link (MVP) → recipient follows link → OAuth flow → binding completes.

Email delivery is deferred to a future sub-project.

### 4.5 Logout

- `/api/auth/signout` deletes the `sessions` row and clears the cookie
- A background job (daily) purges expired sessions

### 4.6 Session verification at the API

Fastify plugin decorates each request:

```
// apps/api/src/plugins/auth.ts
fastify.decorateRequest('user', null)

fastify.addHook('onRequest', async (req, reply) => {
  const token = req.cookies['next-auth.session-token']
  if (!token) return

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.sessionToken, token),
    with: { user: true }
  })
  if (session && session.expires > new Date()) {
    req.user = session.user
    req.perm = await resolvePermissions(session.user.id)
  }
})
```

tRPC context and REST handlers both consume `req.user` / `req.perm`.

### 4.7 Cookie sharing across apps

- `apps/web` and `apps/api` deployed under the same cookie domain (e.g. `app.example.com`)
- `NEXTAUTH_URL` and `AUTH_SECRET` identical in both
- CORS not needed if same origin; CSRF protection via `sameSite=lax` + Auth.js state param

### 4.8 Security hardening

- `AUTH_SECRET` validated at startup: `z.string().min(32)`
- OAuth client secrets only in env, never written to DB or logs
- Rate limit `/api/auth/*`: 10 requests/minute/IP via `@fastify/rate-limit`
- `BOOTSTRAP_SUPER_ADMIN_EMAIL` required before first user registration succeeds

---

## 5. RBAC

### 5.1 Role × action matrix

| Action | super_admin (global) | org_admin (org) | dept_manager (dept) | team_manager (team) | member |
|---|:---:|:---:|:---:|:---:|:---:|
| `platform.manage_all_orgs` | ✅ | — | — | — | — |
| `org.read` | ✅ | ✅ own org | ✅ own org | ✅ own org | ✅ own org |
| `org.update` | ✅ | ✅ own org | — | — | — |
| `dept.create` / `update` / `delete` | ✅ | ✅ | — | — | — |
| `team.create` | ✅ | ✅ | ✅ in dept | — | — |
| `team.update` / `delete` | ✅ | ✅ | ✅ in dept | ✅ own team | — |
| `team.add_member` | ✅ | ✅ | ✅ in dept | ✅ own team | — |
| `user.invite` | ✅ | ✅ | ✅ to teams in dept | ✅ to own team | — |
| `user.read` (team members) | ✅ | ✅ org-wide | ✅ in dept | ✅ own team | ✅ self only |
| `role.grant` (at/below own scope) | ✅ | ✅ | ✅ team_manager / member only | ✅ member only | — |
| `audit.read` | ✅ | ✅ own org | ✅ own dept | — | — |

**Core rules:**
- Permissions propagate **downward** (org_admin inherits dept_manager and team_manager abilities)
- Permissions cannot be escalated **upward** (team_manager cannot grant dept_manager)
- `member` may only view their own data
- Deny overrides are **not** supported in MVP (allow-only model)

### 5.2 Permission resolution

```
function resolvePermissions(userId: string): UserPermissions {
  const assignments = db.query(
    role_assignments
    WHERE user_id = userId AND revoked_at IS NULL
  )

  for each assignment a:
    switch a.scope_type:
      case 'global':       a.covered_orgs = ALL; a.covered_depts = ALL; a.covered_teams = ALL
      case 'organization': a.covered_orgs = [a.scope_id]
                           a.covered_depts = depts where org_id = a.scope_id
                           a.covered_teams = teams where org_id = a.scope_id
      case 'department':   a.covered_depts = [a.scope_id]
                           a.covered_teams = teams where department_id = a.scope_id
      case 'team':         a.covered_teams = [a.scope_id]  // future: recurse parent_team_id

  return merged UserPermissions {
    roles_by_scope, covered_orgs, covered_depts, covered_teams
  }
}
```

Resolution is cached per-request, not globally.

### 5.3 `can()` function

Pure function in `packages/auth/src/rbac/check.ts`:

```
type Action =
  | { type: 'user.invite'; orgId?: string; teamId?: string }
  | { type: 'team.update'; teamId: string }
  | { type: 'org.update'; orgId: string }
  | ...

function can(perm: UserPermissions, action: Action): boolean
```

### 5.4 Enforcement points

**Fastify REST:**

```
fastify.post('/v1/teams/:id/members', {
  preHandler: [authRequired, requirePerm(r => ({
    type: 'team.add_member', teamId: r.params.id
  }))]
}, handler)
```

**tRPC:**

```
const managerProcedure = protectedProcedure
  .input(z.object({ teamId: z.string().uuid() }))
  .use(async ({ ctx, input, next }) => {
    if (!can(ctx.perm, { type: 'team.update', teamId: input.teamId }))
      throw new TRPCError({ code: 'FORBIDDEN' })
    return next()
  })
```

**Service layer:** defense-in-depth — service functions re-check permissions before DB calls, so internal callers cannot bypass.

### 5.5 Audit write

State-changing operations (role grant/revoke, invite, team/dept/org create/update/delete) write a row to `audit_logs` via a decorator or middleware in the service layer.

---

## 6. API Surfaces

### 6.1 Path plan

| Path | Purpose |
|---|---|
| `/trpc/*` | Web UI ↔ server (tRPC) |
| `/api/v1/*` | CLI / agent REST (skeleton only in this spec) |
| `/api/auth/*` | Auth.js OAuth flow |
| `/health`, `/health/ready` | Healthcheck |
| `/openapi.json`, `/docs` | OpenAPI + Swagger UI (dev only unless `ENABLE_SWAGGER=true`) |

### 6.2 tRPC router layout

```
appRouter = {
  me:            meRouter,
  organizations: orgRouter,
  departments:   deptRouter,
  teams:         teamRouter,
  users:         userRouter,
  invites:       inviteRouter,
  roles:         roleRouter,
  auditLogs:     auditRouter,
}
```

#### 6.2.1 `me`
| Procedure | Input | Output |
|---|---|---|
| `session` (query) | — | user + active assignments + covered_orgs/depts/teams |
| `updateProfile` (mutation) | `{ name?, image? }` | updated user |

#### 6.2.2 `organizations`
| Procedure | Input | Required permission |
|---|---|---|
| `list` (query) | — | any authenticated (filtered by covered_orgs) |
| `get` (query) | `{ id }` | `org.read` |
| `create` (mutation) | `{ name, slug }` | `super_admin` |
| `update` (mutation) | `{ id, name }` | `org.update` |
| `delete` (mutation) | `{ id }` | `super_admin` |

#### 6.2.3 `departments`
| Procedure | Input | Required permission |
|---|---|---|
| `list` | `{ orgId }` | `org.read` |
| `get` | `{ id }` | scope-visible |
| `create` | `{ orgId, name, slug }` | `dept.create` |
| `update` | `{ id, name }` | `dept.update` |
| `delete` | `{ id }` | `dept.delete` |

#### 6.2.4 `teams`
| Procedure | Input | Required permission |
|---|---|---|
| `list` | `{ orgId?, departmentId? }` | scope-visible |
| `get` | `{ id }` | `team.read` |
| `create` | `{ orgId, departmentId?, name, slug }` | `team.create` |
| `update` | `{ id, name, departmentId? }` | `team.update` |
| `delete` | `{ id }` | `team.delete` |
| `addMember` | `{ teamId, userId }` | `team.add_member` |
| `removeMember` | `{ teamId, userId }` | `team.add_member` |

#### 6.2.5 `users`
| Procedure | Input | Required permission |
|---|---|---|
| `list` | `{ orgId?, teamId?, search? }` | scope-visible |
| `get` | `{ id }` | self or `user.read` |

#### 6.2.6 `invites`
| Procedure | Input | Required permission |
|---|---|---|
| `create` | `{ email, role, scope_type, scope_id }` | `user.invite` |
| `list` | `{ orgId }` | `user.invite` |
| `revoke` | `{ id }` | `user.invite` |
| `accept` | `{ token }` | authenticated |

#### 6.2.7 `roles`
| Procedure | Input | Required permission |
|---|---|---|
| `grant` | `{ userId, role, scope_type, scope_id }` | `role.grant` at/below scope |
| `revoke` | `{ assignmentId }` | `role.grant` |
| `listForUser` | `{ userId }` | self or `user.read` |

#### 6.2.8 `auditLogs`
| Procedure | Input | Required permission |
|---|---|---|
| `list` | `{ orgId?, actorId?, action?, since, until, limit }` | `audit.read` |

### 6.3 REST skeleton

```
GET  /health                 -> { status: 'ok', version, db: 'up' }
GET  /health/ready           -> 200 when migrations applied and DB reachable; else 503
POST /api/v1/ingest          -> 501 Not Implemented (reserved for next sub-project)
GET  /api/v1/reports/:id     -> 501 Not Implemented (reserved for next sub-project)
```

`apps/api/src/rest/` contains stub modules so the file layout is stable before the ingestion sub-project begins.

### 6.4 Error contract

**tRPC:** uses standard `TRPCError` codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`, `INTERNAL_SERVER_ERROR`).

**REST:**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to perform this action",
    "requestId": "01HX..."
  }
}
```

### 6.5 Request ID and logging

- Fastify auto-generates `req.id`
- pino enriches every log with `{ reqId, userId }`
- Error responses echo `requestId` so users can correlate against server logs

### 6.6 Input validation

- tRPC: `.input(z.object(...))`
- REST: `fastify-type-provider-zod` validates body/query/params
- slug: `/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/`
- IDs: `z.string().uuid()`

### 6.7 Rate limits

| Path | Limit |
|---|---|
| `/api/auth/*` | 10/min/IP |
| `/trpc/*` | 600/min/user |
| `/api/v1/*` | Not set in this spec (next sub-project handles token quotas) |

---

## 7. Deployment & CI/CD

### 7.1 Dockerfiles

Two multi-stage images under `docker/`:

- `Dockerfile.api`: builds `apps/api`, exposes port 3001, healthcheck hits `/health`.
- `Dockerfile.web`: builds `apps/web` using Next.js standalone output, exposes port 3000.

Base image: `node:20-alpine`. pnpm installed via `corepack`.

### 7.2 Dev compose

`docker/docker-compose.dev.yml` starts only PostgreSQL. `apps/api` and `apps/web` run on the host with hot reload via `pnpm dev`.

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
volumes:
  pg_data:
```

### 7.3 Prod compose

`docker/docker-compose.yml` includes `postgres`, a one-shot `migrate` container, `api`, and `web`. All images pulled from `ghcr.io/hanfour/aide-*:${VERSION:-latest}`. `depends_on.condition: service_completed_successfully` guarantees migrations run before app services start.

A `.env.example` lives at the repo root listing every required variable.

### 7.4 Migration strategy

- `packages/db/src/migrate.ts` uses `drizzle-orm/node-postgres/migrator`
- Generated SQL is committed at `packages/db/drizzle/`
- Prod order: postgres healthy → migrate completes → api/web start
- Migrations are forward-only; rollback is via DB snapshot

### 7.5 Environment validation

`packages/config/src/env.ts` parses `process.env` with zod at startup and calls `process.exit(1)` with a clear stderr message on failure. Required keys:

```
NODE_ENV
DATABASE_URL
AUTH_SECRET                        (≥ 32 chars)
NEXTAUTH_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
BOOTSTRAP_SUPER_ADMIN_EMAIL        (required before first user registration)
BOOTSTRAP_DEFAULT_ORG_SLUG         (required; e.g. "onead"; used by bootstrap path and seed)
BOOTSTRAP_DEFAULT_ORG_NAME         (required; human-readable org name)
ENABLE_SWAGGER                     (optional; defaults false in production)
LOG_LEVEL                          (default 'info')
```

### 7.6 GitHub Actions workflows

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR, push to main | pnpm install, turbo `lint typecheck test build` |
| `migration-check.yml` | PR touching `packages/db` | drizzle-kit `check`; apply on disposable pg |
| `e2e.yml` | PR, nightly | Build, start Docker compose, wait for `/health`, run Playwright |
| `release.yml` | Tag `v*` | Build and push images for `api` and `web` to `ghcr.io` |

### 7.7 Release process

1. Tag: `git tag v0.x.y && git push --tags`
2. `release.yml` builds and pushes Docker images
3. Users self-update: `docker compose pull && docker compose up -d`

---

## 8. Testing Strategy

### 8.1 Layers

| Layer | Tool | Target | Coverage |
|---|---|---|---|
| Unit | vitest | Pure functions: `can()`, scope expansion, zod schemas | ≥ 90% |
| Integration | vitest + testcontainers-postgres | tRPC procedures end-to-end, DB migrations, Auth.js flow | ≥ 80% |
| E2E | Playwright | Critical user flows | Key paths |

Overall coverage target: **≥ 80%**; `packages/auth` target **≥ 95%**.

### 8.2 Integration DB strategy

- Each test file starts one PostgreSQL container in `beforeAll`, stops in `afterAll`
- Each test wraps in `BEGIN` / `ROLLBACK` for isolation
- In CI, use GitHub Actions `services: postgres` instead of testcontainers for speed

### 8.3 Fixtures / factories

`apps/api/tests/factories/` exports:
- `makeOrg(db, overrides?)`
- `makeUser(db, { orgId, role?, scope?, ... })`
- `makeTeam(db, { orgId, departmentId? })`
- `signedInAs(user)` → returns a tRPC caller bound to that user's session

### 8.4 Auth.js in tests

`packages/auth/test-adapter.ts` provides `signInAsUser(userId)` that writes a `sessions` row and returns a cookie. Real OAuth providers are disabled when `NODE_ENV === 'test'`.

### 8.5 tRPC testing

`appRouter.createCaller({ db, user, perm, reqId })` bypasses HTTP for most integration tests. One or two routes exercise the full Fastify pipeline via `fastify.inject()`.

### 8.6 RBAC table tests

`packages/auth/tests/unit/rbac/can.test.ts` uses `test.each` with ~60–100 rows covering every role × scope × action combination that matters.

### 8.7 E2E flows (Playwright)

Minimum required:
1. Sign in with Google (mocked OAuth) → dashboard
2. Invite → accept → new user lands in correct org/role
3. Team CRUD (create, rename, delete)
4. RBAC rejection: `member` attempts to create team → 403 UI
5. Audit log: org_admin sees invite and role.grant entries

### 8.8 CI execution

- `pnpm vitest run --coverage` — unit
- `pnpm vitest run --config vitest.integration.config.ts` — integration (with pg service container)
- `pnpm playwright test` — E2E, after `docker compose up`
- Coverage summary posted to PRs

### 8.9 Manual acceptance checklist

A companion acceptance checklist (stored alongside this spec) lists manual test paths a spec reviewer should walk through before considering MVP complete.

---

## 9. Non-Functional Requirements

| Category | Target |
|---|---|
| Performance | tRPC p95 < 200 ms (excluding slow DB queries); login end-to-end < 1.5 s |
| Availability | MVP single instance; `docker compose restart` does not lose data |
| Security | OWASP Top 10 mitigations: SQLi via ORM, XSS via React escaping, CSRF via sameSite + Auth.js state, secrets never logged |
| Data retention | `sessions` purged 30 days after expiry; `audit_logs` retained 365 days (auto-purge deferred) |
| Privacy | emails are PII; logs contain only `user_id`, never email |
| Observability | pino JSON logs, `/health`, `/health/ready`, request ID propagated end-to-end |
| Portability | Linux/macOS Docker; single `docker compose up` brings the stack up |
| i18n | UI strings extracted to `messages/en.json`; English only in MVP |

---

## 10. Milestones

Estimated for one full-time engineer. Halve velocity for part-time.

| # | Milestone | Deliverables | Est. weeks |
|---|---|---|---|
| M1 | Monorepo scaffold | pnpm workspace, turbo, three empty apps, CI lint+typecheck green | 0.5 |
| M2 | DB schema + migrations | 10 tables migrated, `pnpm db:migrate` works, seed script | 0.5 |
| M3 | Auth.js login works | Google OAuth login, `sessions` populated, `/api/auth/signin` end-to-end | 0.5 |
| M4 | RBAC core | `can()` implemented, ~90 table tests green, Fastify `requirePerm`, tRPC `managerProcedure` | 1 |
| M5 | tRPC routers complete | All 8 routers implemented + integration tests | 1.5 |
| M6 | Minimum Web UI | Login page, dashboard listing org/team, org_admin CRUD UI (team/dept/invite) | 1.5 |
| M7 | Dockerization + release | Two Dockerfiles, prod compose, tag `v0.2.0` triggers image push | 0.5 |
| M8 | E2E + acceptance | 5 Playwright flows pass, manual acceptance checklist green | 0.5 |

**Total: ~6 weeks.**

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Auth.js v5 still in beta; API may change | Medium | Pin a specific version; run E2E before upgrading |
| `testcontainers` unreliable on some CI runners | Low | Use GitHub Actions `services: postgres`; keep testcontainers for local dev only |
| Four-level org + scope SQL performs poorly | Medium | Add indexes early (`teams.department_id`, `role_assignments(user_id) WHERE revoked_at IS NULL`); include a load test of 100 users × 1,000 roles |
| Existing CLI collides with new monorepo layout | Medium | Leave CLI untouched this spec; migrate in a later sub-project |
| OAuth client secrets leak | High | `.env.example` explicit; log filtering; strict `.gitignore`; CI uses OIDC, not long-lived tokens |
| Self-hosters expose `/docs` Swagger accidentally | Low | `/docs` disabled in prod unless `ENABLE_SWAGGER=true` |
| First-user-becomes-super-admin path abused | Medium | Require `BOOTSTRAP_SUPER_ADMIN_EMAIL` env to match before promotion; otherwise deny login |

---

## 12. Out of Scope

Already stated per section; consolidated here:

- **Data ingestion** (CLI sync, hook upload) → sub-project ③
- **Raw data ingestion pipeline** (dedup, storage) → sub-project ④
- **Server-side evaluation engine** (`packages/core` on DB) → sub-project ⑤
- **Evaluation standard Web UI CRUD** → sub-project ⑥
- **Report UI** (dashboards, charts, export) → sub-project ⑦
- **Email delivery** (invites, reports) → sub-project ⑧
- **K8s Helm, HA, automated backups** → sub-project ⑩
- **SAML / OIDC enterprise SSO** → v2 auth expansion
- **Email + Password auth** → v2 auth expansion

---

## 13. Open Questions

These do not block spec approval; they are tracked for adjustment during implementation.

1. **Bootstrap mode:** is "first user auto becomes super_admin, constrained by env var" safe enough, or should it require a CLI command (`aide admin bootstrap --email X`)?
2. **Org slug mutation:** should we allow changing `organizations.slug` after creation? MVP position: **no** (URL breakage risk).
3. **Removal from all teams:** when a user is removed from the last team, does org membership persist? MVP position: **yes**, preserve `organization_members`.
4. **Multi-org users:** can one email belong to multiple orgs? MVP position: **yes**, via multiple `organization_members` rows.

---

## 14. Definition of Done

- [ ] `pnpm install && pnpm dev` starts all three apps locally
- [ ] `docker compose -f docker/docker-compose.dev.yml up postgres` + `pnpm dev` integrates smoothly
- [ ] `pnpm db:migrate && pnpm db:seed` creates a demo org plus super_admin
- [ ] Both Google and GitHub OAuth sign-in work
- [ ] super_admin can create org / dept / team, invite a user, and grant a role
- [ ] Each of the five roles enforces the RBAC matrix for a representative action
- [ ] `/health` returns `{ status: 'ok', db: 'up' }`
- [ ] `/docs` Swagger is reachable in dev; disabled by default in prod
- [ ] CI workflows (`ci`, `migration-check`, `e2e`, `release`) all green
- [ ] Docker images `ghcr.io/hanfour/aide-api:v0.2.0` and `aide-web:v0.2.0` pull and run via `docker compose up`
- [ ] All 5 Playwright E2E flows pass
- [ ] Coverage ≥ 80% overall; `packages/auth` ≥ 95%

---

## 15. Next Steps After Approval

1. User reviews this spec.
2. On approval, invoke the `superpowers:writing-plans` skill to convert this design into a concrete implementation plan broken down per milestone (M1 → M8).
3. Implementation plan drives execution per the project's TDD workflow.
