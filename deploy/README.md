# Deploy on one VM

The dashboard runs on a single Linux machine. nginx serves the built web app
and proxies `/api` to the API. Two systemd services run the block follower and
the API. SQLite lives on the local disk. No containers.

## Size

| Resource | Minimum | Why |
|---|---|---|
| CPU | 2 vCPU | one block every 12 s takes 60–300 ms; the rest is idle |
| Memory | 4 GB | follower ~150 MB, API ~100 MB, the rest is page cache for SQLite |
| Disk | 40 GB SSD | about 10 GB per week of live data at the default 7-day retention |
| Network | any | one block fetch per 12 s; ~230 KB per open browser tab per block |

Examples: Hetzner CX22 / CPX21, DigitalOcean 2 vCPU / 4 GB, GCP e2-medium.
A 2 GB machine works but leaves SQLite little cache; avoid it.

## Steps

All commands run as root on the VM.

1. Create the layout and the user.

   ```bash
   mkdir -p /opt/ccd
   useradd --system --home-dir /opt/ccd --shell /usr/sbin/nologin ccd
   ```

2. Clone the app and the registry.

   ```bash
   git clone https://github.com/sourcifyeth/clear-signing-coverage-dashboard /opt/ccd/app
   git clone https://github.com/ethereum/clear-signing-erc7730-registry /opt/ccd/registry
   ```

3. Write the env file. Start from the example and set the RPC key.

   ```bash
   cp /opt/ccd/app/.env.example /opt/ccd/env
   chmod 600 /opt/ccd/env
   nano /opt/ccd/env      # set RPC_URL or DRPC_API_KEY; leave DB_PATH and REGISTRY_PATH unset
                          # SOURCIFY_TOKEN (optional): the x-sourcify-token value that lifts
                          # sourcify.dev's rate limit for the follower's sync and the API's proxy
   ```

   The unit files set `DB_PATH`, `REGISTRY_PATH`, `HOST` and `PORT` themselves.

4. Run the installer. It installs Node 20 and nginx, builds the web app,
   installs the services, the nginx site and the cron job, and starts everything.

   ```bash
   SITE_DOMAIN=coverage.example.org /opt/ccd/app/deploy/install.sh
   ```

5. Point DNS at the VM, then add TLS.

   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d coverage.example.org
   ```

## After the first start

- `journalctl -u ccd-follower -f` shows one line per block. The first line
  reports the window rebuild; the next ones read `block N txs=… cov=…`.
- `curl localhost:8787/api/live/latest` returns the newest stored block.
- The page shows numbers within a minute. The 24h and 7d windows fill up over
  the first day and week.
- The Sourcify verification sync runs inside the follower. Its lines start with
  `contracts:`. The queue is large at first and drains at about 14,000
  contracts per hour.

## Day to day

- Update to the latest `master`: `/opt/ccd/app/deploy/update.sh`
- The registry is pulled every 10 minutes by cron. When it changed, the
  follower restarts, and new descriptors count from the next block.
- Logs: `journalctl -u ccd-follower`, `journalctl -u ccd-api`,
  `/var/log/nginx/ccd.*.log`.
- Stop cleanly: `systemctl stop ccd-follower` sends SIGINT; the follower
  finishes its block and the sync finishes its request.

## Files

| File | Installed as |
|---|---|
| `systemd/ccd-follower.service` | `/etc/systemd/system/ccd-follower.service` |
| `systemd/ccd-api.service` | `/etc/systemd/system/ccd-api.service` |
| `nginx/ccd.conf` | `/etc/nginx/sites-available/ccd` |
| `cron/ccd-registry-sync` | `/etc/cron.d/ccd-registry-sync` |
| `registry-sync.sh` | run by cron |
| `update.sh` | run by hand |

## Not covered here

- Backups: the live tables rebuild themselves within the retention window.
  Only the archived BigQuery snapshot is worth keeping, and it is static.
- More than one machine: the API is a single process. See the growth notes in
  the main README before scaling out.
