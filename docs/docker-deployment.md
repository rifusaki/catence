# Docker Deployment Quick Start and Common Commands

This document mirrors the [local quick start](../README.md#quick-start) and [common operations](../README.md#common-operations) for Catence when deployed via Docker. It assumes you have completed the [deployment steps](deployment.md#path-b--docker-deployment) and have a running `catence-deploy` stack.

## Quick Start (Docker)

All commands run from the `catence-deploy` directory created by the deploy script.

### 1. Initialize an athlete store

```sh
docker compose -f docker-compose.yml --env-file .env run --rm \
  --entrypoint catence-data console setup --athlete alex --label "Alex"
```

### 2. Store provider credentials (stdin only, never shell history)

```sh
# Garmin
printf %s 'alex@example.com' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider garmin --field password --value-stdin

# Intervals.icu
printf %s 'intervals-api-key' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider intervals --field apiKey --value-stdin
printf %s '12345' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider intervals --field athleteId --value-stdin

# Strava (create an API application at https://www.strava.com/settings/api)
printf %s 'strava-client-id' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider strava --field clientId --value-stdin
printf %s 'strava-client-secret' | docker compose -f docker-compose.yml --env-file .env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider strava --field clientSecret --value-stdin
```

### 3. Sync data and build retrieval context

```sh
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data sync --athlete alex --provider all --home /data
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data build-retrieval-index --athlete alex --home /data
```

### 4. Access the Console

Open `http://127.0.0.1:8000` (or the `--bind:--port` you configured) and log in with `CATENCE_CONSOLE_USERNAME` and the password whose hash is in `CATENCE_CONSOLE_PASSWORD_HASH`.

---

## Common Operations (Docker)

The `sync.sh` helper in `catence-deploy/` wraps the most frequent `catence-data` calls inside the **running** container (so the provider secrets from the data volume are already available).

```sh
# Incremental sync for one athlete (all providers)
./sync.sh --athlete alex sync

# Sync a specific provider
./sync.sh --athlete alex sync --provider intervals

# Sync from a specific date (Garmin)
./sync.sh --athlete alex sync --provider garmin --from 2025-07-29

# Full backfill from a date
./sync.sh --athlete alex backfill 2026-01-01

# Backfill with refresh (re-fetch existing data)
./sync.sh --athlete alex backfill 2026-01-01 --refresh

# Retry a failed sync run
./sync.sh --athlete alex retry --run <run-id>

# Coverage and error status
./sync.sh --athlete alex status

# List athlete IDs in the catalog
./sync.sh athletes

# Strava OAuth (uses clientId/clientSecret stored for this athlete)
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data auth strava --athlete alex --callback --home /data
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data disconnect strava --athlete alex --home /data

# Strava OAuth via SSH (remote Docker host accessed over SSH/Tailscale)
## Option 1: SSH Port Forwarding (recommended)
# On your LOCAL machine, forward the callback port to the remote Docker host:
ssh -L 8765:127.0.0.1:8765 user@docker-host
# Then run the standard callback flow on the REMOTE host (uses http://127.0.0.1:8765/strava/callback)
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data auth strava --athlete alex --callback --home /data

## Option 2: Manual code exchange with http://localhost
# On the REMOTE host, get the authorization URL:
docker compose -f docker-compose.yml --env-file .env run --rm \
  --entrypoint catence-data console auth strava \
  --athlete alex --redirect-uri "http://localhost" --home /data
# Open the printed URL in YOUR LOCAL BROWSER, approve Strava, then copy the 'code' from the redirect URL
# Exchange the code on the REMOTE host:
docker compose -f docker-compose.yml --env-file .env run --rm \
  --entrypoint catence-data console auth strava \
  --athlete alex --code "THE_CODE_FROM_URL" --redirect-uri "http://localhost" --home /data

# Update the runtime and Console (re-run deploy script on the same channel)
curl -fsSL https://raw.githubusercontent.com/rifusaki/catence/beta/scripts/deploy-console.sh | bash -s beta
# or from checkout: ./scripts/deploy-console.sh beta

# Choose a non-default catalog location (bind mount instead of named volume)
# Stop the stack, edit docker-compose.yml to replace the volume with:
#   volumes:
#     - /srv/catence:/data
# Then restart and run the same commands (--home /data is implied by CATENCE_HOME).
```

---

## Connecting to the Docker-based MCP from Outside

### The MCP Server Inside the Container

By default, the Catence MCP server runs on **loopback only** inside the container at `http://127.0.0.1:8787/mcp`. It is **never exposed** to the host network or the internet — this is intentional for security.

The `CATENCE_MCP_BIND` variable controls **two things at once**:

1. **Docker port mapping**: which host interface exposes port 8787 to the Docker host.
2. **Server listen address**: which address the MCP server binds to inside the container.

| Value | Docker maps | Server binds | Effect |
|-------|-------------|--------------|--------|
| `127.0.0.1` (default) | `127.0.0.1:8787 → container:8787` | `127.0.0.1` | MCP reachable only from the Docker host's loopback — requires SSH tunnel for remote access. |
| `0.0.0.0` | `0.0.0.0:8787 → container:8787` | `0.0.0.0` | MCP reachable from any network interface — suitable for Tailscale or VPN exposure. |

Set it at deploy time with `--mcp-bind`, or by editing `CATENCE_MCP_BIND` in `.env`:

```sh
# Default (loopback only — SSH tunnel required for remote access)
./scripts/deploy-console.sh beta

# Tailscale / network exposure
./scripts/deploy-console.sh beta --mcp-bind 0.0.0.0
```

To change the binding after deployment, update `CATENCE_MCP_BIND` in `.env` and restart:

```sh
sed -i 's/CATENCE_MCP_BIND=.*/CATENCE_MCP_BIND=0.0.0.0/' catence-deploy/.env
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env up -d
```

### SSH Port Forwarding (Recommended for Remote MCP Clients)

From your **local machine**, forward the container's MCP port through the Docker host:

```sh
# Forward local port 8787 → Docker host port 8787 → container loopback 8787
ssh -L 8787:127.0.0.1:8787 user@docker-host
```

Then point your MCP client at `http://127.0.0.1:8787/mcp` on your local machine.

### Exposing MCP on Tailscale (Alternative)

To expose the MCP server directly on a Tailscale interface (or any network interface) without SSH tunneling:

```sh
# Deploy with MCP bound to all interfaces (0.0.0.0) — restrict via Tailscale ACLs/firewall
./scripts/deploy-console.sh beta --mcp-bind 0.0.0.0
```

Or set the environment variable before deploying:

```sh
CATENCE_MCP_BIND=0.0.0.0 ./scripts/deploy-console.sh beta
```

After deployment, the MCP server is available at `http://<tailscale-ip>:8787/mcp` from any device on your tailnet.

**Security note**: The MCP server has **no authentication** — it trusts the caller's `athleteId` parameter. When exposing on `0.0.0.0`, you **must** restrict access at the network layer (Tailscale ACLs, firewall rules, etc.). The Console UI remains on loopback (`127.0.0.1:8000`) and should still be fronted by Cloudflare Tunnel or a reverse proxy.

**Examples: Common MCP Clients**

```sh
# Via SSH tunnel (default loopback deployment)
# Opencode
opencode mcp add catence -- http://127.0.0.1:8787/mcp

# Codex
codex mcp add catence -- http://127.0.0.1:8787/mcp

# Claude Desktop
claude mcp add --transport http catence -- http://127.0.0.1:8787/mcp
```

```sh
# Via Tailscale (when deployed with --mcp-bind 0.0.0.0)
# Replace <tailscale-ip> with your server's Tailscale IP (from `tailscale ip`)
# Opencode
opencode mcp add catence -- http://<tailscale-ip>:8787/mcp

# Codex
codex mcp add catence -- http://<tailscale-ip>:8787/mcp

# Claude Desktop
claude mcp add --transport http catence -- http://<tailscale-ip>:8787/mcp
```

### Why Not Expose Port 8787 Directly?

- The MCP server has **no authentication** — it trusts the caller's `athleteId` parameter.
- Exposing it would allow any network caller to read all athlete data in the catalog.
- The Console proxies dashboard requests through its **authenticated** same-origin route.
- SSH port forwarding keeps the trust boundary at your SSH credentials.

---

## Quick Reference: `docker compose run` vs `docker compose exec`

| Command Type | Use For | Example |
|--------------|---------|---------|
| `run --rm --entrypoint catence-data console` | **One-off setup/secrets** — needs fresh stdin for `--value-stdin`, no running container required | `secret set`, `setup`, `auth strava --code` |
| `exec console catence-data` | **Recurring ops** — uses the running container's environment (secrets already in volume) | `sync`, `backfill`, `status`, `build-retrieval-index` |

The `sync.sh` helper uses `exec` for this reason.