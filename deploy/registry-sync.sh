#!/usr/bin/env bash
# Pull the ERC-7730 registry checkout; restart the follower if HEAD moved.
# Run by cron (deploy/cron/ccd-registry-sync) as root every 10 minutes.
# The follower loads the coverage set once at start, so a restart is how new
# descriptors start counting.
set -euo pipefail

REG=/opt/ccd/registry
USER_NAME=ccd

as_ccd() { runuser -u "$USER_NAME" -- "$@"; }

before=$(as_ccd git -C "$REG" rev-parse HEAD)
if ! as_ccd git -C "$REG" pull --ff-only --quiet; then
  logger -t ccd-registry-sync "pull failed (HEAD ${before:0:8} kept)"
  exit 1
fi
after=$(as_ccd git -C "$REG" rev-parse HEAD)

if [ "$before" != "$after" ]; then
  systemctl restart ccd-follower
  logger -t ccd-registry-sync "registry ${before:0:8} -> ${after:0:8}; follower restarted"
else
  logger -t ccd-registry-sync "registry unchanged at ${after:0:8}"
fi
