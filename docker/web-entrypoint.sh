#!/bin/sh
# Substitute the API_INTERNAL_URL placeholder into Next.js's
# routes-manifest.json before booting the standalone server. See the comment
# in apps/web/next.config.mjs for why the placeholder dance is necessary —
# Next.js bakes rewrites at build time, but operators set this URL at deploy
# time. Default matches the docker-compose service name.
set -eu

: "${API_INTERNAL_URL:=http://api:3001}"
MANIFEST=/app/apps/web/.next/routes-manifest.json

if [ -f "$MANIFEST" ] && grep -q '__AIDE_INTERNAL_API_URL__' "$MANIFEST"; then
  # Escape for sed: only `|` is a delimiter; URLs may legitimately contain it
  # (e.g. credentials in a redis://...) but for HTTP(S) URLs `|` is safe.
  sed -i "s|__AIDE_INTERNAL_API_URL__|${API_INTERNAL_URL}|g" "$MANIFEST"
fi

exec node apps/web/server.js
