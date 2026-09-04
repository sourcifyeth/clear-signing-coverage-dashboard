#!/usr/bin/env bash
# First-time install on a fresh Ubuntu 22.04 / 24.04 VM. Idempotent: safe to
# run again after a change to the unit files or the nginx site.
#
#   sudo SITE_DOMAIN=coverage.example.org /opt/ccd/app/deploy/install.sh
#
# Expects the repo cloned at /opt/ccd/app, the registry at /opt/ccd/registry,
# and the env file at /opt/ccd/env (see deploy/README.md for those steps).
set -euo pipefail

APP=/opt/ccd/app
REG=/opt/ccd/registry
DATA=/opt/ccd/data
ENV_FILE=/opt/ccd/env
USER_NAME=ccd
SITE_DOMAIN="${SITE_DOMAIN:-_}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi
for p in "$APP" "$REG" "$ENV_FILE"; do
  if [ ! -e "$p" ]; then
    echo "missing $p (see deploy/README.md)" >&2
    exit 1
  fi
done

echo "== system user and directories"
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir /opt/ccd --shell /usr/sbin/nologin "$USER_NAME"
fi
mkdir -p "$DATA" /opt/ccd/.npm
chown -R "$USER_NAME:$USER_NAME" "$APP" "$REG" "$DATA" /opt/ccd/.npm
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
# The services read the env file as the ccd user through systemd, which opens
# it as root before dropping privileges; 600 root:root is what we want.

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl ca-certificates >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v), npm $(npm -v)"

as_ccd() { runuser -u "$USER_NAME" -- env HOME=/opt/ccd "$@"; }

echo "== npm ci (dev dependencies included: tsx runs the services)"
as_ccd npm --prefix "$APP" ci --include=dev --no-audit --no-fund
echo "== build web app"
as_ccd npm --prefix "$APP" run build --workspace apps/web

echo "== systemd units"
install -m 644 "$APP/deploy/systemd/ccd-follower.service" /etc/systemd/system/ccd-follower.service
install -m 644 "$APP/deploy/systemd/ccd-api.service" /etc/systemd/system/ccd-api.service
systemctl daemon-reload
systemctl enable ccd-follower ccd-api >/dev/null
systemctl restart ccd-follower ccd-api

echo "== nginx site (server_name ${SITE_DOMAIN})"
sed "s/__SITE_DOMAIN__/${SITE_DOMAIN}/" "$APP/deploy/nginx/ccd.conf" > /etc/nginx/sites-available/ccd
ln -sf /etc/nginx/sites-available/ccd /etc/nginx/sites-enabled/ccd
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== registry sync cron"
install -m 644 "$APP/deploy/cron/ccd-registry-sync" /etc/cron.d/ccd-registry-sync
chmod +x "$APP/deploy/registry-sync.sh" "$APP/deploy/update.sh"

sleep 3
echo "== status"
systemctl --no-pager --lines=0 status ccd-follower ccd-api || true
curl -fsS http://127.0.0.1:8787/api/live/latest || echo "(API not answering yet; check: journalctl -u ccd-api -n 50)"
echo
echo "done. Next: point DNS at this host, then: certbot --nginx -d ${SITE_DOMAIN}"
