#!/usr/bin/env bash
# Update a running deployment to the latest master: pull, install, rebuild the
# web app, restart both services. Run as root: sudo /opt/ccd/app/deploy/update.sh
set -euo pipefail

APP=/opt/ccd/app
USER_NAME=ccd

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

as_ccd() { runuser -u "$USER_NAME" -- env HOME=/opt/ccd "$@"; }

echo "== git pull"
as_ccd git -C "$APP" pull --ff-only
echo "== npm ci (dev dependencies included: tsx runs the services)"
as_ccd npm --prefix "$APP" ci --include=dev --no-audit --no-fund
echo "== build web app"
as_ccd npm --prefix "$APP" run build --workspace apps/web

echo "== restart services"
systemctl restart ccd-api ccd-follower
sleep 2
systemctl --no-pager --lines=0 status ccd-follower ccd-api || true
echo "== $(git -C "$APP" log -1 --format='%h %s')"
