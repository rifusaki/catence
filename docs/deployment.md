# Deploying Catence Console

Catence Console is a password-protected local web chat that starts a matching
Catence runtime on loopback. There are two supported ways to run it: **locally**
(npm package + Python Console on your machine) or **in Docker** (one container
built from the public registries). Both paths end with the same Console, data
directory layout, model configuration, and credentials model.

Everything below assumes a recent beta or stable release; channels are
explained in the [beta release notes](../README.md#beta-releases).

## Prerequisites

- Node.js 22+ and Python 3.12+ with [uv](https://docs.astral.sh/uv/)
  (local path), or Docker Engine with the `docker compose` plugin (Docker path).
- Provider credentials for the athletes you choose to sync (Garmin,
  Intervals.icu, Strava).
- One model-provider key (OpenAI, Anthropic, OpenCode Go, Azure, or any
  OpenAI-compatible endpoint).

## What gets stored where

| What | Where | Example |
| --- | --- | --- |
| Catalog + athlete stores | data home | `~/.catence/` or `/data` in Docker |
| Model profiles (no secrets) | `config.json` in the data home | `console.profiles` |
| Provider credentials | per-athlete secret file, mode 0600 | `catence-data secret set` |
| API keys | process environment only | `.env` in Docker, shell exports locally |
| Chat history + preferences | data home | `console/chat-history.sqlite3` |

Credentials never land in `config.json`; profiles reference environment
variable *names* (`apiKeyEnv`, `apiBaseEnv`, `apiVersionEnv`). See
[`llm-providers.md`](llm-providers.md) for the profile reference and
[`config.example.json`](../config.example.json) for a complete example.

---

## Path A — Local deployment

### 1. Install the runtime and the Console

```sh
npm install --global catence@beta          # or catence@latest for stable
uv tool install catence-console            # persistent `catence-console` command
# alternative to the last line: uvx catence-console@<version> serve (ephemeral)
```

`catence-console serve` launches a matching Catence runtime automatically: it
uses a globally installed `catence` if present, otherwise `npx catence@<pinned>`.

### 2. Create the catalog and first athlete

```sh
catence-data setup --athlete alex --label "Alex"
```

This creates `~/.catence/` (or `$CATENCE_HOME`). It also tolerates a directory
that already holds only Console artifacts (`config.json`, `console/`).

### 3. Store provider credentials (stdin only, never shell history)

```sh
printf %s 'alex@example.com' | catence-data --athlete alex secret set --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | catence-data --athlete alex secret set --provider garmin --field password --value-stdin
printf %s 'intervals-api-key' | catence-data --athlete alex secret set --provider intervals --field apiKey --value-stdin
printf %s '12345' | catence-data --athlete alex secret set --provider intervals --field athleteId --value-stdin
```

### 4. Sync data and build retrieval context

```sh
catence-data --athlete alex sync --provider all
catence-data --athlete alex build-retrieval-index
```

### 5. Configure the model

On the first chat, the Console wizard asks for a provider and model and writes
a starter profile. To start from the documented profiles instead, copy the
`console` section from [`config.example.json`](../config.example.json) into
`~/.catence/config.json`. To add OpenCode Go models, run the
[model discovery script](#model-discovery-opencode-go) below.

### 6. Set the model credentials and Console login

```sh
export OPENAI_API_KEY='…'                        # or ANTHROPIC_API_KEY / OPENCODE_GO_API_KEY …
export CATENCE_CONSOLE_USERNAME='coach'
export CATENCE_CONSOLE_PASSWORD_HASH="$(catence-console auth hash-password)"
export CHAINLIT_AUTH_SECRET="$(openssl rand -hex 32)"
```

### 7. Start the Console

```sh
catence-console serve
# open http://127.0.0.1:8000
```

The Model dropdown in the settings panel lists every profile's deployments.
Preflight with:

```sh
catence-console doctor
```

---

## Path B — Docker deployment

### 1. Deploy with the script

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

### 2. Fill in `catence-deploy/.env`

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

Then start the stack (or re-run the script, which re-reads the saved `.env`):

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env up -d
```

### 3. Initialize an athlete store

The data volume already contains a seeded `config.json`, so `setup` accepts
it. Run through the container:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint catence-data console setup --athlete alex --label "Alex"
```

### 4. Store provider credentials

```sh
printf %s 'value' | docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm -T \
  --entrypoint catence-data console --athlete alex secret set \
  --provider intervals --field apiKey --value-stdin
```

Use the same `--entrypoint catence-data` pattern for `sync`, `backfill`, and
`auth strava`.

### 5. Configure the model

The seeded `config.json` already offers OpenAI, OpenAI-compatible, and
Anthropic starter profiles, so the settings panel works before the first chat.
Edit `/data/config.json` inside the volume:

```sh
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint sh console -c 'cat > /data/config.json'   # paste JSON, then Ctrl-D
```

With `--home <dir>` (bind mount), edit `<dir>/config.json` on the host
instead. To add OpenCode Go models, see [model discovery](#model-discovery-opencode-go).

### 6. Expose the Console safely

Keep the Console port bound to `127.0.0.1` (the default) and front it with a
Cloudflare Tunnel or reverse proxy at HTTPS. Never expose Catence's MCP port
8787 — it stays loopback-only inside the container. For remote MCP checks use
SSH port forwarding (`ssh -L 8787:127.0.0.1:8787 server`).

---

## Model discovery (OpenCode Go)

OpenCode Go publishes an OpenAI-compatible API at
`https://opencode.ai/zen/go/v1`; its model list is public. The discovery
script fetches it and merges two ready-made profiles into `config.json`:
`opencode-go` (chat + responses models, base `…/zen/go/v1`) and
`opencode-go-messages` (messages models, base `…/zen/go`). Existing profiles,
limits, and `defaultProfile` are preserved unless `--set-default` is passed.

```sh
# Local (from a checkout)
npm run discover:opencode-go -- --write ~/.catence/config.json

# Docker (the script ships inside the npm package in the image)
docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env run --rm \
  --entrypoint node console \
  /usr/local/lib/node_modules/catence/scripts/discover-opencode-go.mjs --write /data/config.json
```

Then set the credentials and verify. The generated `.env` already contains
`OPENCODE_GO_API_BASE` and `OPENCODE_GO_MESSAGES_API_BASE`, so on Docker only
the key is missing:

```sh
export OPENCODE_GO_API_KEY='…'                      # any non-empty value passes the key check
catence-console doctor
```

The `openai/responses/…` models (for example `grok-4.5`) go through LiteLLM's
responses bridge and are the least battle-tested path; smoke-test one chat turn
before relying on them.

---

## Updating

From `catence-data update`-capable releases (0.2.0-beta.3 and later), the
runtime updates both components on the tracked channel — beta installs follow
the npm `beta` tag and matching PyPI prereleases:

```sh
catence-data update --check      # report only; exit 1 when updates are pending
catence-data update              # npm runtime + uv tool catence-console upgrade
catence-data update --channel stable   # move off a beta onto the stable channel
```

Older betas (for example a beta 2 install) predate the command; upgrade them
manually once:

```sh
npm install --global catence@beta
uv tool install --upgrade catence-console
```

Docker deployments: re-run `deploy-console.sh beta` (or `stable`); it
re-resolves the newest versions from the registries and rebuilds. The data
volume and your `config.json` are preserved.

## Troubleshooting

- **"No Catence config exists"** — should not happen after a seeded deploy or
  wizard run; ensure `/data/config.json` (Docker) or `~/.catence/config.json`
  exists and contains a `console` section.
- **"Refusing to initialize"** — the data home contains unrelated files; the
  error lists them. Console artifacts (`config.json`, `console/`, and Chainlit's
  `.files/`, `.chainlit/`, `public/`) are allowed; anything else blocks `setup`.
- **Settings panel has no Model dropdown** — the Console loads profiles from
  `config.json`; write one via the wizard, a manual copy, or the discovery
  script.
- **Profile not ready** — `catence-console doctor` lists the missing
  environment variables; set them in `.env` (Docker) or the shell (local) and
  restart the Console.