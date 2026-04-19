# Self-hosting aide

This guide walks you through running `aide` (platform mode) on your own
infrastructure using the published Docker images. For CLI mode, see the root
`README.md`.

## 1. Prerequisites

- **Docker 27+** with the `compose` plugin (`docker compose version`).
- A **domain name** you control (e.g. `aide.example.com`) pointing at the host.
- **OAuth applications** registered with:
  - Google Cloud Console — OAuth 2.0 Client ID
  - GitHub Developer Settings — OAuth App
- For each provider, set the authorized redirect URL to:
  `https://<your-domain>/api/auth/callback/<provider>`
  (e.g. `https://aide.example.com/api/auth/callback/google`).

A reverse proxy (Caddy, Traefik, Nginx) in front of the web container handles
TLS termination. The compose stack itself only exposes web on port 3000.

## 2. Grab the compose files

```sh
git clone https://github.com/hanfour/aide.git
cd aide/docker
cp .env.example .env
```

Then edit `.env` and fill in:

| Var | Meaning |
|---|---|
| `VERSION` | The image tag to pull (e.g. `v0.2.0`). See [releases](https://github.com/hanfour/aide/releases). |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Postgres credentials (stay internal to the compose network). |
| `AUTH_SECRET` | **≥32 bytes** of randomness. Generate with `openssl rand -base64 48`. |
| `NEXTAUTH_URL` | Public URL users sign in from. Must match the OAuth redirect host. |
| `GOOGLE_CLIENT_ID/SECRET` | From Google Cloud Console. |
| `GITHUB_CLIENT_ID/SECRET` | From GitHub Developer Settings. |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | The first email to sign in gets `super_admin`. |
| `BOOTSTRAP_DEFAULT_ORG_SLUG/NAME` | A default org is created on first sign-in. |

## 3. First run

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

What happens in order:
1. `postgres` comes up and passes its healthcheck.
2. `migrate` runs once against the fresh DB — applies all Drizzle migrations.
3. `api` starts and becomes healthy when `/health` responds.
4. `web` starts and begins proxying `/trpc` and `/api/v1` to `api` over the
   internal compose network.

Once healthy, point your reverse proxy at `web:3000` and sign in at
`https://<your-domain>/sign-in` using the email you set as
`BOOTSTRAP_SUPER_ADMIN_EMAIL`. You'll be granted `super_admin` automatically
and the default org will be created.

## 4. Updating

Pin a new `VERSION` in `.env`, then:

```sh
docker compose pull
docker compose up -d
```

The `migrate` service reruns automatically — it only applies migrations that
haven't been applied yet. Downtime is roughly the time to start the new
containers (a few seconds).

## 5. Backup

The only durable state is the Postgres volume `docker_pg_data`. Recommended
approach: scheduled `pg_dump` from the running container.

```sh
docker compose exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
  > "aide-$(date +%F).dump"
```

Restore into a fresh volume with:

```sh
docker compose exec -T postgres \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --clean < aide-YYYY-MM-DD.dump
```

Keep backups encrypted and off-host.

## 6. Troubleshooting

### OAuth redirect errors

The most common failure: `redirect_uri_mismatch`. The registered URL in
Google/GitHub must be **exactly** `https://<host>/api/auth/callback/<provider>`
with no trailing slash and with the scheme Users actually hit.

### `/health/ready` returns 503

Usually means migrations haven't run. Check `docker compose logs migrate`.
If `migrate` exited non-zero, `api` and `web` will never start — investigate
the migration error before restarting the stack.

### `OAuthAccountNotLinked`

A user already has an account with one provider and tried a different one
for the same email. Sign in with the original provider, then link the second
provider from Profile.

### `api` marked unhealthy

Run `docker compose exec api wget -qO- http://localhost:3001/health`. If the
response is `db: down`, Postgres is unreachable — check network and
credentials. If Postgres is fine, check `docker compose logs api` for the
underlying error.

### Resetting completely

**Destructive — wipes all data.**

```sh
docker compose down --volumes
```

## Reference

- Production compose: [`docker/docker-compose.yml`](../docker/docker-compose.yml)
- Env schema: [`packages/config/src/env.ts`](../packages/config/src/env.ts)
- Releases / image tags: <https://github.com/hanfour/aide/releases>
