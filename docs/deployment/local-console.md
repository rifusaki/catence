# Local Console deployment

Catence Console is a password-protected local web chat that starts a matching
Catence runtime on loopback. It uses Chainlit password login and fails closed
unless all three authentication variables are supplied.

This guide covers the **local** path: the npm package plus the Python Console
on your machine. The Docker path (one container built from the public
registries) is covered in [`docker.md`](docker.md). Both paths end with the
same Console, data directory layout, model configuration, and credentials
model.

## Prerequisites

- Node.js 22+ and Python 3.12+ with [uv](https://docs.astral.sh/uv/).
- Provider credentials for the athletes you choose to sync (Garmin,
  Intervals.icu, Strava).
- One model-provider key (OpenAI, Anthropic, OpenCode Go, Azure, or any
  OpenAI-compatible endpoint).

## What gets stored where

| What | Where | Example |
| --- | --- | --- |
| Catalog + athlete stores | data home | `~/.catence/` |
| Model profiles (no secrets) | `config.json` in the data home | `console.profiles` |
| Provider credentials | per-athlete secret file, mode 0600 | `catence-data secret set` |
| API keys | process environment only | shell exports |
| Chat history + preferences | data home | `console/chat-history.sqlite3` |

Credentials never land in `config.json`; profiles reference environment
variable *names* (`apiKeyEnv`, `apiBaseEnv`, `apiVersionEnv`). See
[`llm-providers.md`](../llm-providers.md) for the profile reference and
[`configuration.md`](../configuration.md) for the complete `config.json`
schema.

## 1. Install the runtime and the Console

```sh
npm install --global catence@beta          # or catence@latest for stable
uv tool install catence-console            # persistent `catence-console` command
# alternative to the last line: uvx catence-console@<version> serve (ephemeral)
```

`catence-console serve` launches a matching Catence runtime automatically: it
uses a globally installed `catence` if present, otherwise
`npx catence@<pinned>`.

## 2. Create the catalog and first athlete

```sh
catence-data setup --athlete alex --label "Alex"
```

This creates `~/.catence/` (or `$CATENCE_HOME`). It also tolerates a directory
that already holds only Console artifacts (`config.json`, `console/`).

## 3. Store provider credentials (stdin only, never shell history)

Garmin (`email`, `password`), Intervals.icu (`apiKey`, `athleteId`), and Strava
(`clientId`, `clientSecret`):

```sh
# Garmin
printf %s 'alex@example.com' | catence-data --athlete alex secret set --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | catence-data --athlete alex secret set --provider garmin --field password --value-stdin
# Intervals.icu
printf %s 'intervals-api-key' | catence-data --athlete alex secret set --provider intervals --field apiKey --value-stdin
printf %s '12345' | catence-data --athlete alex secret set --provider intervals --field athleteId --value-stdin
# Strava (create an API application at https://www.strava.com/settings/api)
printf %s 'strava-client-id' | catence-data --athlete alex secret set --provider strava --field clientId --value-stdin
printf %s 'strava-client-secret' | catence-data --athlete alex secret set --provider strava --field clientSecret --value-stdin
```

Set only the providers you actually sync; `secret set` accepts each field
independently.

## 4. Sync data and build retrieval context

```sh
catence-data --athlete alex sync --provider all
catence-data --athlete alex build-retrieval-index
```

## 5. Configure the model

On the first chat, the Console wizard asks for a provider and model and writes
a starter profile to `~/.catence/config.json`. To start from the documented
profiles instead, copy the `console` section from
[`config.example.json`](../../config.example.json) into `~/.catence/config.json`.
To add OpenCode Go models, run the
[model discovery script](../llm-providers.md#opencode).

## 6. Set the model credentials and Console login

```sh
export OPENAI_API_KEY='…'                        # or ANTHROPIC_API_KEY / OPENCODE_GO_API_KEY …
export CATENCE_CONSOLE_USERNAME='coach'
export CATENCE_CONSOLE_PASSWORD_HASH="$(catence-console auth hash-password)"
export CHAINLIT_AUTH_SECRET="$(openssl rand -hex 32)"
```

The Console fails closed unless `CATENCE_CONSOLE_USERNAME`,
`CATENCE_CONSOLE_PASSWORD_HASH` (a bcrypt hash), and `CHAINLIT_AUTH_SECRET`
are all set. There is one shared account; the username/password pair grants a
single `console-owner` role.

## 7. Start the Console

```sh
catence-console serve
# open http://127.0.0.1:8000
```

The Model dropdown in the settings panel lists every profile's deployments.
Preflight with:

```sh
catence-console doctor
```

### Manage models in the Console

The **Models** page (header button) manages the model list without editing
`config.json` by hand:

- Enable/disable toggles hide models from the chat's Model dropdown. Disabled
  choices are stored per machine in the Console database
  (`console/chat-history.sqlite3`), never in `config.json`, and the Console
  refuses to disable the only enabled model.
- **Add a custom model** appends one deployment to an existing profile — id,
  display label, LiteLLM reference (`openai/…`, `anthropic/…`,
  `openai/responses/…`), and optional fixed reasoning effort or a custom
  variants map.
- **Remove / Make default** edit `config.json`'s console section directly;
  every other section is preserved, the result is re-validated with the same
  strict parser used at startup before it replaces the file, and secrets stay
  forbidden (only environment-variable names are ever stored).

The dashboard header has a **Sync data** button that starts the same detached
sync as `catence-data sync --provider all` through the authenticated Console
origin, shows live progress while the run is active, and displays the last
completed sync afterwards. Each manual sync also refreshes OpenCode Go model
profiles first; a discovery failure never blocks the data sync.

## Console serve options

`catence-console serve` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `--home <dir>` | `$CATENCE_HOME` or `~/.catence` | Catalog home the runtime serves |
| `--mcp-url <url>` | `$CATENCE_MCP_URL` or auto-start | If given, waits for an existing runtime instead of starting one |
| `--ui-host <host>` | `$CATENCE_CONSOLE_HOST` or `127.0.0.1` | Web UI bind address |
| `--mcp-host <host>` | `127.0.0.1` | Loopback host for the auto-started runtime |
| `--mcp-port <port>` | `8787` | Loopback port for the auto-started runtime |
| `--ui-port <port>` | `8000` | Web UI port |
| `--no-build-ui` | — | Deprecated no-op |
| `--external-mcp` | — | Deprecated alias for `--mcp-url` |

When no `--mcp-url` is given, the Console spawns a matching runtime
(`catence serve --home <home> --host <mcp-host> --port <mcp-port>
--allow-origin http://127.0.0.1:<ui-port> --allow-origin http://localhost:<ui-port>`)
and waits for `GET /health` to succeed within 20 seconds. The runtime and
Console must agree on the protocol version; a mismatch is rejected before a
chat starts.

## How multi-athlete works in the Console

The Console shares the same per-athlete stores as MCP, but scoping is
**server-owned, not model-owned**:

- The settings panel has an **Athlete** selector built from
  `GET /api/v1/athletes` on the runtime. The default is the catalog's
  `defaultAthleteId`.
- On every personal-data tool call, the Console **forces** the selected
  athleteId onto the arguments — the model cannot name or switch athletes, and
  a chat's system message states: *"This Console chat is scoped to athleteId X.
  Every Catence data tool call is forced to that athlete; do not try to select
  or compare another athlete."*
- The athlete choice is persisted per chat thread in the Console's
  `console_preferences` table (`chat-history.sqlite3`), and the chat header
  announces *"This chat is scoped to athlete **<id>**."*
- `list_athletes` is exempt from forcing so the roster can be rendered.

The dashboard is fetched through the authenticated Console origin: Chainlit
middleware proxies `GET /api/v1/dashboard` and `GET /api/v1/athletes` to the
runtime only when the Console's JWT cookie is valid (otherwise 401), so raw
port 8787 does not need to be exposed.

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
```

Then set the credentials and verify:

```sh
export OPENCODE_GO_API_KEY='…'                      # any non-empty value passes the key check
export OPENCODE_GO_API_BASE='https://opencode.ai/zen/go/v1'
export OPENCODE_GO_MESSAGES_API_BASE='https://opencode.ai/zen/go'
catence-console doctor
```

The `openai/responses/…` models (for example `grok-4.5`) go through LiteLLM's
responses bridge and are the least battle-tested path; smoke-test one chat turn
before relying on them.

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

## Troubleshooting

- **"No Catence config exists"** — should not happen after a wizard run; ensure
  `~/.catence/config.json` exists and contains a `console` section (copy it
  from [`config.example.json`](../../config.example.json)).
- **"Refusing to initialize"** — the data home contains unrelated files; the
  error lists them. Console artifacts (`config.json`, `console/`, and
  Chainlit's `.files/`, `.chainlit/`, `public/`) are allowed; anything else
  blocks `setup`.
- **Settings panel has no Model dropdown** — the Console loads profiles from
  `config.json`; write one via the wizard, a manual copy, or the discovery
  script.
- **Profile not ready** — `catence-console doctor` lists the missing
  environment variables; set them in the shell and restart the Console.
- **Runtime not reachable** — `catence-console doctor --home "$HOME/.catence"
  --mcp-url http://127.0.0.1:8787/mcp` checks the handshake; confirm the
  runtime is running on that port and the protocol versions agree.