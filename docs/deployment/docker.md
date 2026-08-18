# Docker deployment

This guide runs the full Catence stack — runtime, MCP server, and Console — in
one container built from the public registries. It is the single deployment
path for a remote or always-on setup and covers the same Console, data
directory layout, model configuration, and credentials model as the
[local path](local-console.md).

Everything below assumes a recent beta or stable release; channels are
explained in the [beta release notes](../../README.md#beta-releases).

## Prerequisites

- Docker Engine with the `docker compose` plugin.
- Provider credentials for the athletes you choose to sync (Garmin,
  Intervals.icu, Strava).
- One model-provider key (OpenAI, Anthropic, OpenCode Go, Azure, or any
  OpenAI-compatible endpoint).

## What gets stored where

| What | Where | Example |
| --- | --- | --- |
| Catalog + athlete stores | data home | `/data` (volume or bind mount) |
| Model profiles (no secrets) | `config.json` in the data home | `console.profiles` |
| Provider credentials | per-athlete secret file, mode 0600 | `catence-data secret set` |
| API keys | process environment only | `.env` |
| Chat history + preferences | data home | `console/chat-history.sqlite3` |

Credentials never land in `config.json`; profiles reference environment
variable *names* (`apiKeyEnv`, `apiBaseEnv`, `apiVersionEnv`). See
[`llm-providers.md`](../llm-providers.md) for the profile reference and
[`configuration.md`](../configuration.md) for the complete `config.json`
schema.

## 1. Deploy with the script

```sh
curl -fsSL https://raw.githubusercontent.com/rifusaki/catence/beta/scripts/deploy-console.sh | bash -s beta
# or from a checkout: ./scripts/deploy-console.sh beta
# use `stable` instead of `beta` for the stable channel
```

The script resolves the newest matching versions from npm and PyPI, writes a
self-contained `catence-deploy/` project (Dockerfile, docker-compose.yml, and
`.env` with placeholders), builds the image, **seeds a starter
`/data/config.json`** into the data volume, and starts the stack — or, when
secrets are missing, prints the remaining steps and exits.

Script options (run `./deploy-console.sh --help` for the full list):

| Option | Default | Meaning |
| --- | --- | --- |
| `--channel stable\|beta` | — | Release channel (also the first positional argument) |
| `--port` | — | Console UI host port |
| `--bind` | `127.0.0.1` | Console UI bind address on the host |
| `--mcp-bind` | `127.0.0.1` | MCP server bind (also sets the compose port mapping; see [MCP exposure](#connecting-to-the-docker-based-mcp-from-outside)) |
| `--dir` | `catence-deploy` | Output directory for the generated scaffold |
| `--username` | — | Console username written into `.env` |
| `--password-hash` | — | bcrypt hash for `CATENCE_CONSOLE_PASSWORD_HASH` |
| `--auth-secret` | — | JWT secret for `CHAINLIT_AUTH_SECRET` |
| `--home <dir>` | — | Host directory bind-mounted to `/data` instead of a named volume |
| `--volume` | — | Named volume name (default `catence`/`catence-beta`) |
| `--env-file` | — | Use an existing `.env` instead of writing a new one |
| `--npm-version` / `--console-version` | — | Pin exact versions instead of resolving the channel |
| `--no-build` / `--no-pull` | — | Skip image build / base image pull |
| `--generate-secrets` | — | Interactively prompt for the password and write the bcrypt hash to `.env` |
| `--dry-run` | — | Print what would be written without changing anything |

## 2. Fill in `catence-deploy/.env`

```sh
CATENCE_CONSOLE_USERNAME=coach
CATENCE_CONSOLE_PASSWORD_HASH='…'      # generate: ./catence-deploy/hash-password.sh
CHAINLIT_AUTH_SECRET='…'               # generate: openssl rand -hex 32
OPENAI_API_KEY='…'                     # or ANTHROPIC_API_KEY / OPENCODE_GO_API_KEY …
OPENAI_API_BASE=''                     # only for OpenAI-compatible endpoints
OPENCODE_GO_API_KEY='…'                # the OpenCode Go base URLs are pre-filled below
OPENCODE_GO_API_BASE='https://opencode.ai/zen/go/v1'
OPENCODE_GO_MESSAGES_API_BASE='https://opencode.ai/zen/go'
```

Generate the Console login hash with the scaffold helper (it prompts on the
terminal, never echoes, and uses the compose project so it works whatever image
tag the script built):

```sh
./catence-deploy/hash-password.sh
```

Or re-run the deploy script with `--generate-secrets` and answer the
interactive prompt. Without the helper (for example an older deployment), the
equivalent command is:

```sh
docker run --rm -it --entrypoint /opt/catence-console/bin/catence-console <image-tag> auth hash-password
```

Then start the stack (or re-run the script, which re-reads the saved `.env`):

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env up -d
```

## 3. Initialize an athlete store

The data volume already contains a seeded `config.json`, so `setup` accepts
it. Run through the container:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint catence-data console setup --athlete alex --label "Alex"
```

## 4. Store provider credentials

Garmin (`email`, `password`), Intervals.icu (`apiKey`, `athleteId`), and Strava
(`clientId`, `clientSecret`), one `printf` per field:

```sh
# Garmin
printf %s 'alex@example.com' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider garmin --field password --value-stdin
# Intervals.icu
printf %s 'intervals-api-key' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider intervals --field apiKey --value-stdin
printf %s '12345' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider intervals --field athleteId --value-stdin
# Strava (create an API application at https://www.strava.com/settings/api)
printf %s 'strava-client-id' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider strava --field clientId --value-stdin
printf %s 'strava-client-secret' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider strava --field clientSecret --value-stdin
```

Set only the providers you actually sync. Use the same `--entrypoint
catence-data` pattern for `sync`, `backfill`, and `auth strava`.

## 5. Sync data and build retrieval context

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  catence-data sync --athlete alex --provider all --home /data
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  catence-data build-retrieval-index --athlete alex --home /data
```

## 6. Configure the model

The seeded `config.json` already offers OpenAI, OpenAI-compatible, and
Anthropic starter profiles, so the settings panel works before the first chat.
Edit `/data/config.json` inside the volume:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint sh console -c 'cat > /data/config.json'   # paste JSON, then Ctrl-D
```

With `--home <dir>` (bind mount), edit `<dir>/config.json` on the host
instead. To add OpenCode Go models from the image (the script ships inside the
npm package):

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint node console \
  /usr/local/lib/node_modules/catence/scripts/discover-opencode-go.mjs --write /data/config.json
```

The generated `.env` already contains `OPENCODE_GO_API_BASE` and
`OPENCODE_GO_MESSAGES_API_BASE`, so on Docker only the key is missing:

```sh
export OPENCODE_GO_API_KEY='…'                      # any non-empty value passes the key check
```

## 7. Access the Console

Open `http://127.0.0.1:8000` (or the `--bind:--port` you configured) and log in
with `CATENCE_CONSOLE_USERNAME` and the password whose hash is in
`CATENCE_CONSOLE_PASSWORD_HASH`.

## 8. Verify with doctor

`catence-console doctor` checks each profile's environment variables and the
local Catence runtime. The deploy scaffold includes a helper for it:

```sh
./catence-deploy/doctor.sh
```

The helper runs the doctor *inside the running container* with `exec` — the
container's own loopback holds the live MCP server at `127.0.0.1:8787`, and the
provider keys from `.env` are already in its environment. (A `docker compose
run` container has a separate loopback and would report the runtime as
unreachable.) The equivalent long form is:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  /opt/catence-console/bin/catence-console doctor --home /data --mcp-url http://127.0.0.1:8787/mcp
```

Expect `"ready": true` once the model key is set; missing keys show up per
profile without ever printing their values.

## Common operations

The `sync.sh` helper in `catence-deploy/` wraps the most frequent
`catence-data` calls inside the **running** container (so the provider secrets
from the data volume are already available):

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
```

`sync` defaults to `--provider all`; extra flags pass through. Set a default
athlete with `export CATENCE_ATHLETE=alex` to drop the `--athlete` argument.
`--detach` starts a sync or backfill in the background and returns immediately;
a detached run keeps streaming into the container logs (`docker compose -f
catence-deploy/docker-compose.yml logs -f console`), keeps writing heartbeats,
and is recoverable by the next sync.

### Sync progress

```sh
./sync.sh --athlete alex sync --detach     # start the run in the background and return
./sync.sh --athlete alex progress --watch  # follow it live
./sync.sh --athlete alex progress          # one-shot snapshot
```

For the full progress-record contract and the sidecar mechanism, see
[`local-mcp.md`](local-mcp.md#background-sync-and-live-progress).

### Strava OAuth

```sh
# Strava OAuth (uses clientId/clientSecret stored for this athlete)
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  catence-data auth strava --athlete alex --callback --home /data
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  catence-data disconnect strava --athlete alex --home /data
```

#### Strava OAuth via SSH (remote Docker host)

**Option 1: SSH port forwarding (recommended).** On your local machine, forward
the callback port to the remote Docker host:

```sh
ssh -L 8765:127.0.0.1:8765 user@docker-host
```

Then run the standard callback flow on the remote host (it uses
`http://127.0.0.1:8765/strava/callback`):

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env exec console \
  catence-data auth strava --athlete alex --callback --home /data
```

**Option 2: manual code exchange with `http://localhost`.** On the remote host,
get the authorization URL:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint catence-data console auth strava \
  --athlete alex --redirect-uri "http://localhost" --home /data
```

Open the printed URL in your local browser, approve Strava, then copy the
`code` from the redirect URL and exchange it on the remote host:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint catence-data console auth strava \
  --athlete alex --code "THE_CODE_FROM_URL" --redirect-uri "http://localhost" --home /data
```

### Raw compose exec one-off commands

The generated scaffold is self-contained, so the same commands work from
inside `catence-deploy/` without the `-f`/`--env-file` prefixes:

```bash
cd catence-deploy
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data sync --athlete martina --provider all --home /data        # incremental sync, all providers
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data backfill --athlete martina --from 2026-01-01 --home /data # full backfill from a date
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data status --athlete martina --home /data                     # coverage/errors
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data progress --athlete martina --home /data --watch           # live sync progress
docker compose -f docker-compose.yml --env-file .env exec console \
  catence-data athlete list --home /data                                 # list athlete IDs
```

## Connecting to the Docker-based MCP from outside

### The MCP server inside the container

By default, the Catence MCP server runs on **loopback only** inside the
container at `http://127.0.0.1:8787/mcp`. It is **never exposed** to the host
network or the internet by default — this is intentional for security.

The `CATENCE_MCP_BIND` variable controls **two things at once**:

1. **Docker port mapping** — which host interface exposes port 8787 to the
   Docker host.
2. **Server listen address** — which address the MCP server binds to inside
   the container.

| Value | Docker maps | Server binds | Effect |
|-------|-------------|--------------|--------|
| `127.0.0.1` (default) | `127.0.0.1:8787 → container:8787` | `127.0.0.1` | MCP reachable only from the Docker host's loopback — requires SSH tunnel for remote access. |
| `0.0.0.0` | `0.0.0.0:8787 → container:8787` | `0.0.0.0` | MCP reachable from any network interface — suitable for Tailscale or VPN exposure. |

Set it at deploy time with `--mcp-bind`, or by editing `CATENCE_MCP_BIND` in
`.env`:

```sh
# Default (loopback only — SSH tunnel required for remote access)
./scripts/deploy-console.sh beta

# Tailscale / network exposure
./scripts/deploy-console.sh beta --mcp-bind 0.0.0.0
```

To change the binding after deployment, update `CATENCE_MCP_BIND` in `.env`
and restart:

```sh
sed -i 's/CATENCE_MCP_BIND=.*/CATENCE_MCP_BIND=0.0.0.0/' catence-deploy/.env
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env up -d
```

### SSH port forwarding (recommended for remote MCP clients)

From your **local machine**, forward the container's MCP port through the
Docker host:

```sh
# Forward local port 8787 → Docker host port 8787 → container loopback 8787
ssh -L 8787:127.0.0.1:8787 user@docker-host
```

Then point your MCP client at `http://127.0.0.1:8787/mcp` on your local
machine.

### Exposing MCP on Tailscale (alternative)

To expose the MCP server directly on a Tailscale interface (or any network
interface) without SSH tunneling:

```sh
# Deploy with MCP bound to all interfaces (0.0.0.0) — restrict via Tailscale ACLs/firewall
./scripts/deploy-console.sh beta --mcp-bind 0.0.0.0
```

Or set the environment variable before deploying:

```sh
CATENCE_MCP_BIND=0.0.0.0 ./scripts/deploy-console.sh beta
```

After deployment, the MCP server is available at
`http://<tailscale-ip>:8787/mcp` from any device on your tailnet.

**Security note:** The MCP server has **no authentication** — it trusts the
caller's `athleteId` parameter. When exposing on `0.0.0.0`, you **must**
restrict access at the network layer (Tailscale ACLs, firewall rules, etc.).
The Console UI remains on loopback (`127.0.0.1:8000`) and should still be
fronted by Cloudflare Tunnel or a reverse proxy.

**Examples: common MCP clients**

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
opencode mcp add catence -- http://<tailscale-ip>:8787/mcp
codex mcp add catence -- http://<tailscale-ip>:8787/mcp
claude mcp add --transport http catence -- http://<tailscale-ip>:8787/mcp
```

### Why not expose port 8787 directly?

- The MCP server has **no authentication** — it trusts the caller's
  `athleteId` parameter.
- Exposing it would allow any network caller to read all athlete data in the
  catalog.
- The Console proxies dashboard requests through its **authenticated**
  same-origin route.
- SSH port forwarding keeps the trust boundary at your SSH credentials.

## Exposing the Console safely

Keep the Console port bound to `127.0.0.1` (the default) and front it with a
Cloudflare Tunnel or reverse proxy at HTTPS. Never expose Catence's MCP port
8787 — it stays loopback-only inside the container. For remote MCP checks use
SSH port forwarding (`ssh -L 8787:127.0.0.1:8787 server`).

### Cloudflare Tunnel

The Console image contains the Node runtime, Catence, and Console. Its MCP
server remains loopback-only inside the container; only the Console port is
exposed. Route a Cloudflare Tunnel to `http://127.0.0.1:8000`; do not run a
tunnel client in this image. Use HTTPS at the tunnel and retain the Console
login — the dashboard is fetched through the authenticated Console origin
rather than directly from port 8787.

### Building the image manually

For a source build instead of the registry artifacts:

```sh
docker build -f console/Dockerfile -t catence-console .
docker run --rm -p 127.0.0.1:8000:8000 -v catence-data:/data \
  -e CATENCE_CONSOLE_USERNAME='coach' \
  -e CATENCE_CONSOLE_PASSWORD_HASH='replace-with-bcrypt-hash' \
  -e CHAINLIT_AUTH_SECRET='replace-with-a-long-random-secret' \
  -e OPENAI_API_KEY='…' \
  catence-console
```

Initialize the mounted volume before its first production sync, for example:

```sh
docker run --rm -it -v catence-data:/data --entrypoint catence-data catence-console \
  setup --athlete alex --label "Alex"
```

Use the same `--entrypoint catence-data` pattern for `secret set` and `sync`.

## Updating

Docker deployments: re-run `deploy-console.sh beta` (or `stable`); it
re-resolves the newest versions from the registries and rebuilds. The data
volume and your `config.json` are preserved.

```sh
curl -fsSL https://raw.githubusercontent.com/rifusaki/catence/beta/scripts/deploy-console.sh | bash -s beta
# or from checkout: ./scripts/deploy-console.sh beta
```

For local (`catence-data update`) updates see
[`local-console.md`](local-console.md#updating).

## Non-default catalog location (bind mount)

Stop the stack, edit `catence-deploy/docker-compose.yml` to replace the volume
with a bind mount:

```yaml
volumes:
  - /srv/catence:/data
```

Then restart and run the same commands (`--home /data` is implied by
`CATENCE_HOME`). The deploy script's `--home <dir>` option does this for you at
deploy time.

## Quick reference: `docker compose run` vs `docker compose exec`

| Command Type | Use For | Example |
|--------------|---------|---------|
| `run --rm --entrypoint catence-data console` | **One-off setup/secrets** — needs fresh stdin for `--value-stdin`, no running container required | `secret set`, `setup`, `auth strava --code` |
| `exec console catence-data` | **Recurring ops** — uses the running container's environment (secrets already in volume) | `sync`, `backfill`, `status`, `build-retrieval-index` |

The `sync.sh` helper uses `exec` for this reason.

## Troubleshooting

- **"No Catence config exists"** — should not happen after a seeded deploy or
  wizard run; ensure `/data/config.json` exists and contains a `console`
  section.
- **"Refusing to initialize"** — the data home contains unrelated files; the
  error lists them. Console artifacts (`config.json`, `console/`, and
  Chainlit's `.files/`, `.chainlit/`, `public/`) are allowed; anything else
  blocks `setup`.
- **Settings panel has no Model dropdown** — the Console loads profiles from
  `config.json`; write one via the wizard, a manual copy, or the discovery
  script.
- **Profile not ready** — `catence-console doctor` lists the missing
  environment variables; set them in `.env` and restart the Console.
- **Doctor reports runtime unreachable** — use `./catence-deploy/doctor.sh`
  (exec) rather than `docker compose run`; a `run` container has a separate
  loopback that cannot see the running MCP server.