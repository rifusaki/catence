# Catence development guide

This is the from-source counterpart to the three deployment guides. Use it to run, edit, and verify Catence without publishing a beta — locally on your machine and on a remote Docker host where you cannot live-debug until a new image is built.

Production installs use published artifacts (`npm install catence@beta` / `uv tool install catence-console` and `scripts/deploy-console.sh` → `console/Dockerfile.registry`). Everything below uses **your checkout directly**, so you can iterate on runtime, ELT, and Console code and test the real volume/config/secret paths before any release.

Related references: [`deployment/local-mcp.md`](deployment/local-mcp.md), [`deployment/local-console.md`](deployment/local-console.md), [`deployment/docker.md`](deployment/docker.md), [`configuration.md`](configuration.md), [`llm-providers.md`](llm-providers.md).

## Which path when

| Goal | Path | Why |
|------|------|-----|
| Test ELT, MCP tools, queries, or TypeScript/Python logic | **Local from source** (`tsx` + `uv run`) | Fastest loop; no Docker, no image build |
| Test the Console UI, Chainlit auth, or the authenticated dashboard proxy | **Local Console from source** (`catence-console serve` against a live `CATENCE_HOME`) | Same stack as production but without a container |
| Test the Docker volume layout, `/data` seeding, `config.json` / `chat-history.sqlite3` persistence, or `deploy-console.sh`-adjacent wiring | **Docker source build** (`console/Dockerfile`) | One `docker build` from the checkout — no registry, no `CATENCE_NPM_VERSION` |
| Iterate inside a container without rebuilding (host file → container) | **Docker live bind-mount** (override entrypoint/command, keep `/data` on a volume) | Edit on host, restart container, re-test |

Most changes do not need Docker at all. Use Docker only when you are explicitly testing the container boundary (file permissions, volume seeding, Console networking, MCP bind).

## Prerequisites

- Node.js 22+
- Python 3.12 ≤ version < 3.14, with [`uv`](https://docs.astral.sh/uv/)
- `git`, `curl`

```sh
git clone https://github.com/rifusaki/catence.git
cd catence
npm ci
uv sync --project console
```

No install step writes to a data home. The data home is created only by `catence-data setup` / `catence-data demo`.

## Local from source (no Docker, no beta)

### Choose a catalog home

The runtime, CLI, and Console all resolve the same home (`~/.catence` by default). Point it elsewhere with `CATENCE_HOME` or per-command `--home` so development never touches a personal catalog.

```sh
# Isolated home for this checkout/session (recommended for development)
export CATENCE_HOME="$PWD/.catence-dev"
catence-data setup --athlete alex --label "Alex"
# or explicitly: catence-data --home "$PWD/.catence-dev" setup --athlete alex --label "Alex"
```

The layout after `setup` is the same one Docker later mounts at `/data` — see [`configuration.md`](configuration.md) and [`deployment/local-console.md`](deployment/local-console.md#what-gets-stored-where):

```text
$CATENCE_HOME/
  catalog.json
  config.json                 # Console model profiles — no secrets
  console/chat-history.sqlite3
  athletes/alex/
    secrets/providers.json    # mode 0600, written only via `secret set --value-stdin`
```

Tear down a dev home with `rm -rf "$CATENCE_HOME"`; it is never committed (covered by `.gitignore`).

For a no-credentials smoke test, use the generated dataset instead:

```sh
catence-data demo                 # creates/reuses ~/.catence-demo with athlete `demo`
npm run mcp -- demo               # stdio MCP against the demo catalog
# The demo home is fixed to ~/.catence-demo; pass --home to move it.
```

### Provider credentials — file (production) or env (dev)

**Preferred (production):** credentials are stored per athlete in `secrets/providers.json` (mode 0600) — never in `config.json`. Same interface as [`deployment/local-mcp.md`](deployment/local-mcp.md#3-store-provider-credentials-stdin-only-never-shell-history):

```sh
# Garmin
printf %s 'alex@example.com' | npm run catence-data -- --athlete alex secret set --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | npm run catence-data -- --athlete alex secret set --provider garmin --field password --value-stdin
# Intervals.icu
printf %s 'intervals-api-key' | npm run catence-data -- --athlete alex secret set --provider intervals --field apiKey --value-stdin
printf %s '12345' | npm run catence-data -- --athlete alex secret set --provider intervals --field athleteId --value-stdin
# Strava (create an API application at https://www.strava.com/settings/api)
printf %s 'strava-client-id' | npm run catence-data -- --athlete alex secret set --provider strava --field clientId --value-stdin
printf %s 'strava-client-secret' | npm run catence-data -- --athlete alex secret set --provider strava --field clientSecret --value-stdin
```

File values always win. Without a file entry the worker's inherited `GARMIN_*` / `INTERVALS_*` / `STRAVA_*` are normally stripped so an unset provider cannot silently inherit another athlete's credentials.

**Easier for local/Docker dev (`src/core/runtime/secrets.ts:51`):** when a `providers.json` field is missing, the worker also checks env fallbacks:

```sh
# Option A — per-athlete scoped (always allowed, multi-athlete safe, no flag)
export CATENCE_ATHLETE_ALEX_GARMIN_EMAIL='alex@example.com'
export CATENCE_ATHLETE_ALEX_GARMIN_PASSWORD='…'
export CATENCE_ATHLETE_ALEX_INTERVALS_API_KEY='…'
export CATENCE_ATHLETE_ALEX_INTERVALS_ATHLETE_ID='12345'
export CATENCE_ATHLETE_ALEX_STRAVA_CLIENT_ID='…'
export CATENCE_ATHLETE_ALEX_STRAVA_CLIENT_SECRET='…'
# Prefix is CATENCE_ATHLETE_<ID>_ where <ID> is the athlete id upper-cased with '-' → '_'.

# Option B — generic (single-athlete dev, opt-in via flag)
export CATENCE_ALLOW_ENV_SECRETS=1          # or CATENCE_SECRETS_FROM_ENV=1 — values 1/true/yes/on
export GARMIN_EMAIL='alex@example.com'
export GARMIN_PASSWORD='…'
export INTERVALS_API_KEY='…'
export INTERVALS_ATHLETE_ID='12345'
export STRAVA_CLIENT_ID='…'
export STRAVA_CLIENT_SECRET='…'
```

Resolution per field: `providers.json` → `CATENCE_ATHLETE_<ID>_<VAR>` → (if `CATENCE_ALLOW_ENV_SECRETS` set) `VAR`. For Docker, put these in `.env.dev` and pass through `environment:` in `docker-compose.dev.yml` (or `--env-file .env.dev`); the `secret set --value-stdin` flow still works inside `docker compose run --entrypoint catence-data` for one-off seeding. See [`configuration.md`](configuration.md#provider-credentials-via-env-dev-fallback) and `.env.example`.

### Model profiles (where model definitions live)

`config.json` in the data home holds **definitions only** — profile ids, LiteLLM model names, and the *names* of environment variables that hold keys/URLs (`apiKeyEnv`, `apiBaseEnv`, `apiVersionEnv`). The values stay in the process environment. See [`configuration.md`](configuration.md#consoleprofiles) and [`llm-providers.md`](llm-providers.md) for the schema.

For development, three options (all write to `config.json` in `CATENCE_HOME`):

```sh
# 1) Start from the documented example
cp config.example.json "$CATENCE_HOME/config.json"
# then set the env var the profile names, e.g. OPENAI_API_KEY / OPENCODE_API_KEY

# 2) Let the Console wizard create one on first chat (replaces the whole `console` section)
# 3) Merge OpenCode Go / Zen profiles without clobbering existing ones
npm run discover:opencode-go -- --write "$CATENCE_HOME/config.json"
npm run discover:opencode-zen -- --write "$CATENCE_HOME/config.json" --free-only

# Verify
npm run console:doctor -- --home "$CATENCE_HOME" --mcp-url http://127.0.0.1:8787/mcp
```

Changing `config.json` is picked up on the next Console request — no repository file tracks deployment-specific models or keys. Keep `config.example.json` as the canonical checked-in example.

### Running MCP, ELT, and tests without building `dist`

`package.json` exposes `tsx` dev scripts so edits are live without `npm run build`. Large edits should still pass `npm run check` (`tsc --noEmit` plus the runtime-boundary guard):

```sh
npm run mcp -- --help
npm run mcp -- --home "$CATENCE_HOME"                    # stdio MCP (same wire as the packaged `catence` bin)
npm run catence-data -- --home "$CATENCE_HOME" status --athlete alex
npm run catence-data -- --home "$CATENCE_HOME" sync --athlete alex --provider garmin --from 2025-07-29
npm run catence-data -- --home "$CATENCE_HOME" build-retrieval-index --athlete alex

# Hot-reload loop for MCP iteration (restarts on src/ change)
npx tsx watch src/interfaces/mcp/main.ts --home "$CATENCE_HOME"

# Tests (DuckDB integration tests use a 15s per-test timeout)
npm test
npm run test:watch
npm run check
```

`npm run mcp` and `npm run catence-data` are thin wrappers for `tsx src/interfaces/{mcp,cli}/main.ts`; the packaged `dist/` is only needed for `npm pack` / `prepublishOnly` validation (`npm run release:check`).

### Running the Console locally against the dev catalog

The Console normally auto-starts a matching packaged runtime (`npx catence@<pinned>`). For development, point it at your live `tsx` runtime instead via `--mcp-url`:

```sh
# Terminal 1 — live MCP/ELT runtime on loopback (no `--` separator; tsx
# forwards arguments verbatim, so a bare `--` would reach the CLI unparsed)
npx tsx watch src/interfaces/mcp/main.ts serve --home "$CATENCE_HOME" --host 127.0.0.1 --port 8787

# Terminal 2 — Console using that runtime (no auto-started `npx` runtime).
# The `console` npm script already ends in the `serve` subcommand, so extra
# arguments after `--` are appended AFTER `serve` — never repeat it here.
export CATENCE_CONSOLE_USERNAME='coach'
export CATENCE_CONSOLE_PASSWORD_HASH="$(uv run --project console catence-console auth hash-password)"
export CHAINLIT_AUTH_SECRET="$(openssl rand -hex 32)"
export OPENAI_API_KEY='…'          # or ANTHROPIC_API_KEY / OPENCODE_API_KEY …
npm run console -- --home "$CATENCE_HOME" --mcp-url http://127.0.0.1:8787/mcp --ui-port 8000
# open http://127.0.0.1:8000
```

`--mcp-url` is the feature that makes the live bind-mount loop below possible — the same flag works when the runtime lives inside a container (see next section).

## Docker without publishing a beta

### Why `scripts/deploy-console.sh` forces a publish

The production scaffold (`scripts/deploy-console.sh`) resolves `CATENCE_NPM_VERSION` / `CATENCE_CONSOLE_VERSION` from the **public registries** and bakes `console/Dockerfile.registry` — a three-line image that runs `npm install --global catence@${CATENCE_NPM_VERSION}` and `uv pip install catence-console==${CATENCE_CONSOLE_VERSION}`. Rebuilding that scaffold on a server cannot test local edits until they exist on npm/PyPI, which is the bottleneck this guide removes.

### Source build — `console/Dockerfile` (reliable, still requires a rebuild)

`console/Dockerfile` is the from-source image: build context is the **repository root**, it runs `npm ci && npm run build && npm install --global .`, then `uv sync --project console`. Build it directly in any checkout, on any server with Docker:

```sh
# From the repository root — tagged independently from the registry channel tags
docker build -f console/Dockerfile -t catence-console:dev .

# Run it the same way `docker.md` does, but with your local env
docker run --rm -p 127.0.0.1:8000:8000 -v catence-dev-data:/data \
  -e CATENCE_CONSOLE_USERNAME='coach' \
  -e CATENCE_CONSOLE_PASSWORD_HASH='replace-with-bcrypt-hash' \
  -e CHAINLIT_AUTH_SECRET='replace-with-a-long-random-secret' \
  -e OPENAI_API_KEY='…' \
  catence-console:dev

# Or bind-mount a host data directory for easy inspection
mkdir -p /srv/catence-dev
docker run --rm -p 127.0.0.1:8000:8000 -v /srv/catence-dev:/data \
  --env-file .env.dev \
  catence-console:dev
```

Seed and inspect the volume exactly as in [`deployment/docker.md`](deployment/docker.md):

```sh
docker run --rm -v catence-dev-data:/data --entrypoint catence-data catence-console:dev setup --athlete alex --label "Alex" --home /data
docker run --rm -v catence-dev-data:/data --entrypoint sh catence-console:dev -c 'ls -R /data; cat /data/config.json'
```

Rebuilding the image is the only step that reflects code changes under this path; the data volume and `config.json` are preserved across rebuilds.

### Live loop — bind-mount the checkout into the container (no rebuild per edit)

When you need to edit on the server itself, mount the checkout into a dev container and have the entrypoint run the `tsx` watcher / `uv run` directly. The scaffold below is intentionally small — it keeps the **data volume** as the only state, so Console auth and `config.json` behave identically to production.

Minimal override compose (save as `docker-compose.dev.yml` alongside the checkout):

```yaml
services:
  console:
    build:
      context: .
      dockerfile: console/Dockerfile
    image: catence-console:dev
    ports:
      - "127.0.0.1:8000:8000"
      - "127.0.0.1:8787:8787"
    environment:
      CATENCE_HOME: /data
      CATENCE_CONSOLE_USERNAME: ${CATENCE_CONSOLE_USERNAME:-}
      CATENCE_CONSOLE_PASSWORD_HASH: ${CATENCE_CONSOLE_PASSWORD_HASH:-}
      CHAINLIT_AUTH_SECRET: ${CHAINLIT_AUTH_SECRET:-}
      # Provider credentials via env (see "Provider credentials" above):
      # Per-athlete scoped vars work without a flag; generic vars need CATENCE_ALLOW_ENV_SECRETS=1.
      CATENCE_ALLOW_ENV_SECRETS: ${CATENCE_ALLOW_ENV_SECRETS:-}
      GARMIN_EMAIL: ${GARMIN_EMAIL:-}
      GARMIN_PASSWORD: ${GARMIN_PASSWORD:-}
      INTERVALS_API_KEY: ${INTERVALS_API_KEY:-}
      INTERVALS_ATHLETE_ID: ${INTERVALS_ATHLETE_ID:-}
      STRAVA_CLIENT_ID: ${STRAVA_CLIENT_ID:-}
      STRAVA_CLIENT_SECRET: ${STRAVA_CLIENT_SECRET:-}
      # Per-athlete example (add your athlete id upper-cased, '-' → '_'):
      # CATENCE_ATHLETE_ALEX_GARMIN_EMAIL: ${CATENCE_ATHLETE_ALEX_GARMIN_EMAIL:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENAI_API_BASE: ${OPENAI_API_BASE:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENCODE_API_KEY: ${OPENCODE_API_KEY:-}
      OPENCODE_GO_API_KEY: ${OPENCODE_GO_API_KEY:-}
      OPENCODE_GO_API_BASE: ${OPENCODE_GO_API_BASE:-}
      OPENCODE_GO_MESSAGES_API_BASE: ${OPENCODE_GO_MESSAGES_API_BASE:-}
      OPENCODE_ZEN_API_BASE: ${OPENCODE_ZEN_API_BASE:-}
      OPENCODE_ZEN_RESPONSES_API_BASE: ${OPENCODE_ZEN_RESPONSES_API_BASE:-}
    volumes:
      - catence-dev-data:/data                 # keep Console data on the volume
      - .:/app                                 # live source
      - /app/node_modules                      # keep container's installed deps
      - /app/console/.venv                     # keep container's venv
      - /app/dist                              # keep container build isolated (see .dockerignore)
      - /app/.catence-dev                      # hide host dev home from container
      - /app/.catence                          # hide host home from container
    command: >-
      sh -c "npm run build &&
             uv run --project /app/console catence-console serve
               --home /data --ui-host 0.0.0.0 --ui-port 8000
               --mcp-host 0.0.0.0 --mcp-port 8787"
      # for no-restart TS hot-reload, replace the command with:
      # npx tsx watch src/interfaces/mcp/main.ts serve --home /data --host 0.0.0.0 --port 8787
      # and run Console separately with --mcp-url

volumes:
  catence-dev-data:
```

```sh
# .env.dev — never committed
cat > .env.dev <<'EOF'
CATENCE_CONSOLE_USERNAME=coach
CATENCE_CONSOLE_PASSWORD_HASH='replace-with-bcrypt-hash'
CHAINLIT_AUTH_SECRET='replace-with-long-random-string'
OPENAI_API_KEY='…'
# Provider creds via env (easier than secret set for dev) — either:
# Per-athlete (always, multi-athlete safe): CATENCE_ATHLETE_ALEX_GARMIN_EMAIL=… 
# Generic (needs flag): CATENCE_ALLOW_ENV_SECRETS=1 + GARMIN_EMAIL=… 
EOF

docker compose -f docker-compose.dev.yml --env-file .env.dev up --build
```

Edits to `src/` and `console/catence_console/` on the host are visible inside; `docker compose restart console` picks up TypeScript changes after `npm run build`, while adding `npx tsx watch` to the command removes even that step. The `/data` volume is still the authority for `config.json`, `secrets/providers.json`, and `console/chat-history.sqlite3`, so the same `catence-data secret set --value-stdin --home /data` flow works via:

```sh
docker compose -f docker-compose.dev.yml --env-file .env.dev exec console \
  catence-data --home /data status --athlete alex
```

An alternative that avoids running `npm` inside the mount loop is to keep the runtime on the host entirely: run `npx tsx watch src/interfaces/mcp/main.ts serve --home /srv/catence-dev ...` on the host and start the Console container with `--mcp-url http://host.docker.internal:8787/mcp` (or the host's Tailscale IP) and `--env-file .env.dev` — the same `--mcp-url` trick from the local Console section.

## Where secrets and model definitions live (dev and Docker)

| What | Local dev | Docker dev/prod | Notes |
|------|-----------|-----------------|-------|
| Catalog + athlete stores | `CATENCE_HOME` (default `~/.catence`, dev: `$PWD/.catence-dev`) | `/data` (volume or bind mount) | Same on-disk layout; `CATENCE_HOME` controls it in both modes |
| Provider credentials (Garmin, Intervals, Strava) | `CATENCE_HOME/athletes/<id>/secrets/providers.json` (mode 0600) **or** env fallback when file field missing | `/data/athletes/<id>/secrets/providers.json` or same env fallback inside container | File wins; env fallback is `CATENCE_ATHLETE_<ID>_<VAR>` (always) or bare `GARMIN_*`/`INTERVALS_*`/`STRAVA_*` when `CATENCE_ALLOW_ENV_SECRETS=1` — see § Provider credentials above. Bare provider env vars are otherwise stripped before workers start |
| Model profiles + limits (`console.profiles`, `console.limits`) | `CATENCE_HOME/config.json` | `/data/config.json` (seeded from `config.example.json` on first deploy) | Versioned definitions + env-var names only. Credentials are read from the environment at serve time |
| API keys / base URLs | Process env (shell `export`, Docker `--env-file .env.dev`) | `.env` / `.env.dev` passed via `environment:` / `--env-file` | Named by the profile's `apiKeyEnv`/`apiBaseEnv`/`apiVersionEnv` (`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `OPENCODE_GO_API_KEY`, …). `catence-console doctor` reports missing vars without printing values |
| Chat history | `CATENCE_HOME/console/chat-history.sqlite3` | `/data/console/chat-history.sqlite3` | Shared between runs when the volume is reused |

Recommended dev defaults:

- Keep a dedicated `CATENCE_HOME` (or local bind-mount path) per checkout or per test run; do not point development at a personal `~/.catence` catalog with real provider tokens.
- Commit no secrets: `.env*` (including `.env.dev`/`.env.beta`) and checkout-local `.catence-*` homes (which contain `athletes/<id>/secrets/providers.json`) are already ignored by `.gitignore`; the default `~/.catence` is outside the repo and naturally untracked.
- Treat `config.example.json` as the canonical model-definition template — copy its `console` section into the dev home's `config.json` and set only the one provider key you are testing.

## Iteration notes

- Re-run `npm run check && npm test` before pushing; `vitest` integration tests create and migrate real DuckDB stores with a 15 s per-test timeout.
- `catence-data update` tracks the registry channel (`latest` vs `beta`); from source the update path is `git pull`, `npm ci && npm run build`, `uv sync --project console`.
- The deployed scaffold's `sync.sh` / `hash-password.sh` / `doctor.sh` helpers are generated by `scripts/deploy-console.sh`; the dev container does not generate them — use the `npm run` / `uv run` equivalents above, or run the same `catence-data --home /data` commands via `docker compose exec`.
- If the Console settings panel shows no Model dropdown, the data home's `config.json` has no `console.profiles` — re-copy `config.example.json` or re-run the discovery script, then restart the Console.

## Troubleshooting

- **Doctor reports runtime unreachable** — the Console was started without `--mcp-url` and its auto-started runtime is on a different port. Start the runtime explicitly and pass `--mcp-url http://127.0.0.1:8787/mcp` to the Console, or use `uv run --project console catence-console doctor --home "$CATENCE_HOME" --mcp-url http://127.0.0.1:8787/mcp`.
- **Docker `run` container has a separate loopback** — `docker compose run` cannot see a `docker compose exec` MCP server. Use `exec` for `doctor`/`sync` against the running container, or use `run` only for one-off `setup`/`secret set` with `--value-stdin`.
- **Refusing to initialize** — the data home contains unrelated files. The error lists them; only `config.json`, `console/`, and Chainlit's `.files/`, `.chainlit/`, `public/` are allowed alongside a catalog.
- **Is a sync actually running? (no deploy scaffold needed)** — three checks, all safe while a sync holds the write lock:
  1. Runtime status API: `curl -s "http://127.0.0.1:8787/api/v1/sync/status?athleteId=<id>" | jq '.progress.running'` (through the Console instead: `/api/v1/sync/status` behind your login).
  2. Detached-child log files: `ls -t "$CATENCE_HOME/logs" | head`. A successful `POST /api/v1/sync` creates `logs/sync-<athlete>-<stamp>.log` before spawning, so an absent or empty `logs/` directory proves no detached sync ever started.
  3. The MCP progress tools (`catence_sync_progress`) read the same heartbeats.
- **Models page clutter** — unused shipped profiles can be hidden per device from the Models page (`Hide` on the profile card); hidden profiles disappear from the chat Model dropdown but stay configured, and are restored with `Unhide`. Hiding lives in the Console database, never in `config.json`.
