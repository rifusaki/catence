# Local Console deployment

Catence Console is a password-protected local web chat that starts a matching
Catence runtime on loopback. It uses Chainlit password login and fails closed
unless `CHAINLIT_AUTH_SECRET` and at least one login source — a stored Console
account or the environment account pair — are configured.

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
| Console logins + athlete grants | data home (mode 0600, bcrypt hashes) | `console/accounts.json` |

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
export CHAINLIT_AUTH_SECRET="$(openssl rand -hex 32)"
```

`CHAINLIT_AUTH_SECRET` is always required: it signs Chainlit sessions. On top
of it, the Console needs at least one login source:

- **Stored accounts** (the multi-user path). Each account carries a role and
  an athlete grant list and lives in `<home>/console/accounts.json`. Create
  the first one with the users CLI, which prompts for the password twice:

  ```sh
  catence-console users add coach --admin
  ```

- **The environment break-glass account**: set both
  `CATENCE_CONSOLE_USERNAME` and `CATENCE_CONSOLE_PASSWORD_HASH` (the bcrypt
  hash printed by `catence-console auth hash-password`). The pair is never
  persisted and always acts as an admin — the way back in when the accounts
  file is lost.

Roles, grants, and the rest of the CLI are described under
[Console accounts](#console-accounts).

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

## Console accounts

Console accounts are Catence's multi-user login model, enforced entirely by
the Console: sign-in, the athlete roster, dashboard and athlete-file requests,
and the athlete scoping of every chat turn are all checked server-side against
the account's role and athlete grants. The MCP server itself is untouched — it
has no authentication and trusts the `athleteId` each call names (see
[local-mcp.md](local-mcp.md#streamable-http-server)); accounts only gate what
goes through the Console.

| Role | Athlete access |
| --- | --- |
| `admin` | Every athlete in the catalog (`athletes: "all"`) |
| `member` | Only the explicitly granted athletes; zero grants allowed |

Accounts live in `<home>/console/accounts.json` (mode 0600, bcrypt hashes
only), where `<home>` is `$CATENCE_HOME` or `~/.catence`. The Console re-reads
the file on every login, so new accounts, password resets, and grant changes
apply without a restart.

### Manage accounts with the users CLI

```sh
catence-console users add coach --admin                    # admin: all athletes
catence-console users add martina --athlete martina        # member with one grant
catence-console users add sam                              # member, zero grants
catence-console users list
catence-console users passwd martina
catence-console users set-role sam member
catence-console users grant sam martina
catence-console users revoke sam martina
catence-console users remove sam
```

- `add <username> (--admin | --athlete <id> [--athlete <id> …])` — members
  default to zero grants; `--admin` cannot be combined with `--athlete` and
  always stores access to every athlete.
- `add` and `passwd` prompt for the password twice (never echoed). For
  automation, `--password-env VAR` reads the password from environment
  variable `VAR` instead, so it never appears in the command line or shell
  history.
- `grant`/`revoke` change a member's athlete list; revoking the last grant
  leaves a zero-grant member. `set-role` promotes or demotes: promoting to
  `admin` coerces the grants to `"all"`, demoting to `member` keeps them.
- `add`/`grant`/`revoke` validate athlete ids against `catalog.json` when it
  exists, and `--home <dir>` points any subcommand at a non-default catalog.

A member with zero grants can sign in and browse the Console, but there is no
athlete to scope a chat to: the Athlete selector is disabled with *"You don't
have access to any athlete yet. Ask an administrator to grant you access."*
and every chat turn is answered with the same notice. A member that requests
an athlete outside their grants receives `403 athlete_forbidden`; the Console
never forwards the request to the runtime.

### The environment break-glass account

`CATENCE_CONSOLE_USERNAME` and `CATENCE_CONSOLE_PASSWORD_HASH` must be set
together. When they are, the pair always acts as an `admin` and is never
written to `accounts.json`: unsetting the two variables revokes it. Use it as
the recovery path when the accounts file is lost or a lockout leaves nobody
who can grant access — not as the everyday login.

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

The Console shares the same per-athlete stores as MCP. Access is layered:
per-account grants at the login, then server-owned scoping per chat.

- **Per-account grants.** Each stored account is an `admin` (every athlete) or
  a `member` with an explicit grant list (see
  [Console accounts](#console-accounts)). The **Athlete** selector and the
  proxied roster are narrowed to the account's grants; requests that name an
  ungranted athlete are refused with `403 athlete_forbidden` before they reach
  the runtime, and a zero-grant member sees no athletes at all.
- The settings panel has an **Athlete** selector built from
  `GET /api/v1/athletes` on the runtime. The default is the catalog's
  `defaultAthleteId` (for a member, the first granted athlete).
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
Re-discovery refreshes each known model's routing reference but keeps your
custom label, `reasoningEffort`, and `variants`, and keeps models that have
disappeared from the live catalog.

```sh
# Local (from a checkout)
npm run discover:opencode-go -- --write ~/.catence/config.json
```

Inside the Console's Models page, **Discover OpenCode Go models** runs the
same merge for the current home without touching athlete data (runtime route
`POST /api/v1/models/discover`, proxied behind the Console login). Models can
also be edited in place there — the update action rewrites the `console`
section atomically and never stores secret values.

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
- **Locked out of the Console** — sign in with the environment break-glass
  account (`CATENCE_CONSOLE_USERNAME`/`CATENCE_CONSOLE_PASSWORD_HASH`) and
  restore access with `catence-console users` (reset a password, re-grant
  athletes, or add a new admin).
