# Local MCP deployment

This guide runs the Catence MCP server on your machine: install the runtime,
create a catalog of athlete stores, sync provider data, and connect MCP clients
over stdio or Streamable HTTP. It does **not** set up the web Console — see
[`local-console.md`](local-console.md) for that.

## Prerequisites

- Node.js 22+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) for the Garmin and Strava
  provider workers
- Provider credentials for the athletes you choose to sync

The default catalog home is `~/.catence`. Set `CATENCE_HOME` or pass `--home`
to use a different location.

## 1. Install

```sh
npm install --global catence@beta      # or catence@latest for stable
```

This installs two binaries:

- `catence` — the MCP server (`catence` starts stdio, `catence serve` starts
  Streamable HTTP, `catence demo` creates a generated store before starting
  stdio).
- `catence-data` — catalog setup, athlete selection, per-athlete secrets,
  `sync`, `backfill`, provider authentication, retrieval-index rebuilding, and
  `demo` generation.

## 2. Create the catalog and first athlete

```sh
catence-data setup --athlete alex --label "Alex"
```

This creates `~/.catence/` (or `$CATENCE_HOME`) with a catalog and the first
athlete store. It also tolerates a directory that already holds only Console
artifacts (`config.json`, `console/`).

## 3. Store provider credentials (stdin only, never shell history)

Provider values are written to the selected athlete's owner-only local secret
file (`secrets/providers.json`, mode 0600). Read them through stdin so they do
not enter shell history:

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

Supported fields per provider: Garmin `email` and `password`; Intervals.icu
`apiKey` and `athleteId`; Strava `clientId` and `clientSecret`. Set only the
providers you actually sync; `secret set` accepts each field independently.

Secrets are injected into provider workers **only** from this per-athlete file;
any `GARMIN_*`/`INTERVALS_*`/`STRAVA_*` values inherited by the shared process
are deliberately stripped. An athlete that has not configured a provider
cannot silently inherit its credentials.

## 4. Sync data and build retrieval context

```sh
catence-data --athlete alex sync --provider all
catence-data --athlete alex build-retrieval-index
```

## 5. Start the stdio MCP server

```sh
catence
```

An agent first calls `list_athletes`, then includes `athleteId` with every
data tool. Tools act only on the named athlete store and never merge athletes
implicitly; the MCP server does not authenticate callers — it trusts the
`athleteId` each call names.

## Multi-athlete catalog

Catence serves several athlete stores from one server. Each store has its own
DuckDB, raw data, and tokens; a call acts on the single store it names and
never merges athletes implicitly. That is a tool contract, not an access
boundary: the stdio server does not authenticate callers and trusts the
`athleteId` they pass — over Streamable HTTP the bearer gate, per-account
keys, or OAuth authenticate and scope callers; see
[MCP clients and HTTP](#streamable-http-server).

### MCP behavior

- `list_athletes` returns `{ defaultAthleteId, athletes: [{ id, label }] }`.
- Every personal-data tool in catalog mode requires an `athleteId` input (the
  server auto-prepends it to every tool schema). Calls without it fail with
  `athleteId is required. Call list_athletes to inspect the configured catalog.`
- The `catence://athletes` resource returns the same catalog.
- Rate limits are tracked **per athlete**: each athlete has its own sliding
  window for server, tool, and resource limits.
- MCP responses carry an `athlete` field identifying which store served them.
- `start_detached_sync` is the one explicitly named write tool besides the
  Strava hydration tools: it spawns a detached `catence-data sync` child for
  the selected athlete and returns immediately with the run handle and log
  file. It refuses to start while another sync run is active (`sync_in_progress`);
  follow the run with `catence_sync_progress`. Pass `backfill: true` with a
  `from` date to spawn `catence-data backfill` instead — history is re-imported
  backwards from that date without advancing the incremental sync cursors.

### Adding another athlete

```sh
catence-data athlete add --id sam --label "Sam"
printf %s 'sam@example.com' | catence-data --athlete sam secret set --provider garmin --field email --value-stdin
printf %s 'sam-password' | catence-data --athlete sam secret set --provider garmin --field password --value-stdin
catence-data --athlete sam sync --provider garmin
catence-data athlete list
```

The catalog layout is deliberately simple:

```text
~/.catence/
  catalog.json
  config.json                     # shared Console configuration; no secrets
  console/chat-history.sqlite3
  athletes/
    alex/                         # isolated DuckDB, raw data, and tokens
      secrets/providers.json      # mode 0600
    sam/
      ...
```

Garmin, Intervals, and Strava client credentials are isolated per athlete.
Strava OAuth tokens remain in that athlete's own store. The old 0.1
single-store directory cannot be migrated safely: create a fresh home and
re-sync each athlete.

## Common operations

```sh
# Incremental or explicit data work for one athlete
catence-data --athlete alex status
catence-data --athlete alex sync --provider intervals
catence-data --athlete alex sync --provider garmin --from 2025-07-29
catence-data --athlete alex backfill --provider garmin --from 2020-01-01 --refresh
catence-data --athlete alex retry --run <run-id>
catence-data --athlete alex progress --watch    # follow an active sync run live

# Strava OAuth uses clientId and clientSecret previously stored for this athlete
catence-data --athlete alex auth strava --callback
catence-data --athlete alex disconnect strava

# Update the runtime and Console together on the tracked release channel
catence-data update --check
catence-data update

# Choose a non-default catalog location
catence-data --home /srv/catence setup --athlete alex --label "Alex"
catence --home /srv/catence
```

`catence-data update` follows the channel of the installed runtime: a beta
install tracks the npm `beta` tag and the matching PyPI prereleases, a stable
install tracks `latest`. Pass `--channel stable` to move off a beta. The
command replaces the global `catence` package and installs or upgrades
`catence-console` with `uv tool` when `uv` is available; `--check` only
reports.

Register `http://127.0.0.1:8765/strava/callback` with the Strava application
for the callback flow. The manual `auth strava --code <authorization-code>`
flow remains available for headless environments.

## Background sync and live progress

Long Garmin backfills fetch hundreds of days of data and can take 20-30+
minutes. Sync runs stream worker output to the console in real time, tolerate
Ctrl+C and SSH/terminal deaths cleanly, and expose a live progress heartbeat
you can follow from the CLI, the MCP server, or a Docker helper.

### What happens during a run

When a sync starts, Catence creates a row in `sync_runs` with status `running`
and begins persisting heartbeats to the `sync_run_progress` table (schema
migration 14). The Garmin staging worker emits one compact JSON progress record
every few seconds on stdout; the runtime parses it, normalizes it, and upserts
it. Even if the worker cannot emit — for example while stuck in login — the
runtime persists a 30-second fallback heartbeat so a run is always observable
and never falsely looks stale.

Each progress record follows the same contract:

- `runId`, `provider` — which run the record belongs to
- `stage` — `starting`, `login`, `singletons`, `daily`, `range`,
  `ftp_history`, `max_metrics`, `hrv_history`, `scores`, `activities`,
  `collections` while extracting; `completed` on success; `failed`,
  `interrupted`, or `timed_out` as terminal states written by the runtime
- `currentStep` — the endpoint, date, or activity being fetched right now
- `completedUnits` / `totalUnits` — for example days fetched out of the total
  days in the window
- `percentComplete` — 0 to 100
- `elapsedSeconds` / `estimatedRemainingSeconds` — the ETA is computed once the
  run has a known total and has completed at least one unit
- `heartbeatAt` — UTC ISO timestamp of the record

#### Live progress never needs the database lock

DuckDB is a single-writer database: a running sync holds an exclusive lock on
the store file, so no other process — not even a read-only one — can open it
until the run finishes. To keep progress observable during a run, every
heartbeat is also written to a sidecar file at
`staging/garmin/<run-id>.progress.json` (atomic write, no database access).
`progress`, `catence_sync_progress`, and the MCP server read the sidecar files
for live runs and only touch the `sync_run_progress` table for recent-run
history once the lock is free — so they keep working while a backfill holds the
lock, and never crash with a lock error.

Progress also stays live through the entire run, not just worker extraction: a
30-second keep-alive covers the JSONL import phase (which emits no worker
output) and the `intervals` phase of a provider-all sync or backfill.

Other read-only tools (`status`, `query_read_only_data`, and friends) still
need the database and therefore return a clean `data_sync_in_progress` error
while a sync run is active. That is expected behavior: the store is locked
until the run completes, then they are served from the same snapshot.

### Interruption and stale-run recovery

- SIGINT, SIGTERM, and SIGHUP (Ctrl+C, terminal close, `kill`) are trapped on
  both the Node runtime and the Python worker. The child stops between days and
  the run is marked `interrupted` in `sync_runs` — never a zombie `running`
  row — and the process exits with 130/143/129.
- Before every sync or retry, runs still stuck in `running` for more than 15
  minutes are marked `timed_out` (with `completed_at` set), so a dead SSH
  session cannot block later syncs.
- Resume a failed or interrupted run without re-reading history with
  `retry --run <run-id>`.

### Watching progress

```sh
catence-data --athlete alex progress          # one-shot JSON snapshot
catence-data --athlete alex progress --watch  # live view; exits when no run is active
```

`--watch` renders a compact progress table on a TTY and exits when the last
active run finishes; piped output stays JSON.

The read-only MCP tool `catence_sync_progress` returns the same snapshot —
active runs with their latest heartbeat plus the most recent runs — and takes
`athleteId` like every other personal-data tool.

## Safe demo and Glama

Run a clearly marked generated dataset without provider accounts:

```sh
npx --yes catence@beta demo
```

It creates or reuses `~/.catence-demo` with one `demo` athlete. The generated
data has explicit caveats in every tool response and never contains personal
measurements. The Glama registry entry uses this command for **Try in
Browser**, so the hosted sandbox has no access to local credentials or
personal data.

From a checkout:

```sh
npm run mcp -- demo
```

`catence-data demo` and `catence demo` both use `~/.catence-demo` by default
and refuse to modify an existing directory unless it contains the Catence demo
marker.

## MCP clients and HTTP

For a packaged installation, point a client at `catence`:

```sh
codex mcp add catence -- catence
claude mcp add --transport stdio catence -- catence
```

For a source checkout:

```sh
codex mcp add catence -- npm --prefix /absolute/path/to/catence run mcp
```

### Streamable HTTP server

Optional local Streamable HTTP MCP and dashboard APIs:

```sh
catence serve --host 127.0.0.1 --port 8787
```

By default it is loopback-only. `CATENCE_HTTP_HOST` and `CATENCE_HTTP_PORT`
override the host and port when the flags are omitted.

#### Bearer-token authentication

The server has no authentication of its own; when it must be reachable beyond
loopback (for example through a Cloudflare Tunnel to an MCP client such as
Mistral Work), switch on the bearer-token gate. The gate is armed at a token
file — `<catalog-home>/mcp-token` by default, or the path given by
`--auth-token-file` (environment equivalent: `CATENCE_MCP_TOKEN_FILE`) — and
the **file's presence is the switch**: create it to enable, remove it to
disable, no restart needed. The gate is also armed when the per-account key
registry holds at least one active key or when OAuth is enabled (see the next
sections); only with no token file, no keys, and no OAuth configured is the
server open.

Catence generates the token itself; never hand-craft one:

```sh
catence-data mcp status    # enabled, token file, endpoint URLs
catence-data mcp enable    # generate the token file (mode 0600) if missing
catence-data mcp token      # print the token for the client credential flow
catence-data mcp disable   # remove the file; remote access is refused again
```

- Every endpoint except `/health` and `/api/v1/health` (kept open for readiness
  probes) answers `401` without an exact `Authorization: Bearer <token>`
  header while the gate is on. A request with no token gets no
  `WWW-Authenticate` at all, so MCP clients with auth auto-detection (Mistral
  Work) classify the server as bearer-auth rather than OAuth; with OAuth
  enabled a token-less `401` instead gains a
  `WWW-Authenticate: Bearer resource_metadata="<public-url>/.well-known/oauth-protected-resource/mcp"`
  challenge — see [OAuth 2.1 (ChatGPT/Codex)](#oauth-21-chatgptcodex). A request
  that presents a wrong or expired token gets
  `WWW-Authenticate: Bearer error="invalid_token", error_description="The access token is invalid or expired."`
  with no `resource_metadata`: the client already holds a credential, so it is
  told the token is bad instead of being steered into the OAuth flow.
- CORS preflights (`OPTIONS`) pass through without a token.
- An existing but unreadable or empty token file fails closed: the gate
  rejects everything except the health probes until the file is fixed or
  removed.
- `GET /api/v1/mcp-exposure` reports the same status the Console Settings page
  shows (including the token); `POST /api/v1/mcp-exposure` with
  `{"enabled": true|false}` toggles the gate. The Console exposes both to
  admins only.
- Rotation: `catence-data mcp disable && catence-data mcp enable` (or rewrite
  the file), then re-authenticate the MCP client. Keep the token out of
  `.env`, `config.json`, shell history, and repositories.
- The Console attaches the same header automatically to its runtime calls and
  reads the token file lazily, so enabling the gate from the Console or CLI
  needs no Console restart either.

- `GET /api/v1/athletes` returns IDs and labels only.
- `POST /api/v1/athletes` creates a catalog athlete from
  `{"id": "sam", "label": "Sam", "setDefault": false}` and answers with the
  updated roster; duplicate ids are refused with `409 athlete_exists`, and
  single-store runtimes without a catalog with `400 catalog_required`.
- `GET /api/v1/dashboard` requires `athleteId`, for example
  `http://127.0.0.1:8787/api/v1/dashboard?athleteId=alex&days=28` (`endDate`
  is an optional `YYYY-MM-DD`; `days` ranges 1-90 and defaults to 28).
- `POST /api/v1/sync` starts a detached data sync for one athlete:
  `{"athleteId": "alex", "provider": "all", "from": "2026-01-01", "refresh": false}`.
  The spawned child outlives the request, logs to `<home>/logs/`, and the call
  returns `202` with the run handle immediately; an already-active run is
  refused with `409 sync_in_progress`. Pass `"refreshModels": true` to also
  refresh OpenCode Go model profiles first (failure is a non-fatal warning in
  the response). Pass `"backfill": true` with a required `"from"` date
  (`YYYY-MM-DD`) to run `catence-data backfill` instead: history is re-imported
  backwards from that date without advancing the incremental cursors. The
  Console's Status tab exposes the same control (date picker + "Backfill
  history").
- `GET /api/v1/sync/status?athleteId=alex` reports live progress heartbeats,
  recent runs, and best-effort last-completion timestamps per provider. It
  keeps working while a sync holds the write lock (`lastSync` becomes `null`
  then). Finished runs are never reported as active, so a completed or
  crashed run can never wedge the busy guard.
- `POST /api/v1/models/discover` refreshes the OpenCode Go profiles in
  `<home>/config.json` without starting a data sync:
  `{"setDefault": false}` (both fields optional). Returns the merged profile
  ids, per-route counts, and any prefix-guessed routes.
- Browser origins must be listed with `--allow-origin` (repeatable). The
  packaged Console instead proxies the dashboard through its authenticated
  same-origin route.

#### Per-account API keys

The shared bearer token is a single admin credential. For per-account access,
create API keys bound to Console accounts (`console/accounts.json`). A key acts
as its account: an admin account's key sees every athlete, a member account's
key sees only that account's granted athletes.

The key registry lives at `<catalog-home>/mcp-keys.json` — override with
`--mcp-keys-file` or `CATENCE_MCP_KEYS_FILE`. In the Docker deployment the
default is `/data/mcp-keys.json` inside the data volume: runtime-managed, no
host mount needed. The file is written atomically with mode 0600 and stores
only SHA-256 token hashes. Any active key in the registry arms the gate,
exactly like the token file's presence does.

```sh
catence-data mcp status                                    # gate, token, key counts, OAuth state
catence-data mcp key add --account coach --label "vibe"   # prints the raw token exactly once
catence-data mcp key list                                  # ids, labels, accounts — never hashes
catence-data mcp key roll <id>                             # new raw token, printed exactly once
catence-data mcp key revoke <id>                           # stops working immediately
```

All four accept `--file <path>` for a non-default registry. Every Console
account manages its own keys in Settings → API keys (create with a label — the
raw token is shown once — plus roll and revoke); admins additionally see the
whole registry in Settings → MCP Exposure → API keys with an account picker.
The HTTP API `GET`/`POST`/`DELETE /api/v1/mcp-keys` and `POST
/api/v1/mcp-keys/roll` enforce the same boundary for direct callers and for
key- or OAuth-authenticated sessions: an admin principal may manage any
account's keys, any other principal only its own (`403 admin_required`
otherwise), and a non-admin's list shows only its own account's keys.

Scope semantics:

- A key is bound to a Console account; its athlete scope is the account's
  grant list, resolved live from `console/accounts.json` on every request.
- Scope is enforced in the runtime for both MCP tools and the HTTP APIs: an
  out-of-scope `athleteId` is refused with `403 athlete_forbidden` over HTTP
  (`athlete_forbidden` tool error over MCP), and `list_athletes`,
  `catence://athletes`, and `GET /api/v1/athletes` are filtered to the scope.
- Admin-only APIs (`POST /api/v1/athletes`, `/api/v1/mcp-exposure`,
  `/api/v1/models/discover`) require an admin principal: the legacy token is
  always admin, an account key is admin only when its account is. The key
  registry APIs are account-scoped instead of admin-only — admins manage every
  account's keys, any other principal only its own (see above).
- Fail closed: a revoked key, a deleted account, or an unreadable registry or
  accounts file rejects the request (`401`) — never an anonymous fallback.
- The raw token is shown exactly once (on `add` and `roll`); only its hash is
  stored. Keep it in a password manager, out of `.env`, `config.json`, shell
  history, and repositories.
- `mcp disable` only closes the shared-token path: while keys or OAuth are
  configured, exposure stays armed through them.

#### OAuth 2.1 (ChatGPT/Codex)

`catence serve --oauth --public-url <url>` runs an OAuth 2.1 authorization
server inside the runtime so ChatGPT and Codex can connect with their native
OAuth flow. The environment equivalents are `CATENCE_OAUTH_ENABLED=1|true` and
`CATENCE_PUBLIC_URL=<url>`.

From the Console, open Settings → MCP exposure → **OAuth 2.1 sign-in**: set the
public URL and flip the switch. The Console writes
`<catalog-home>/oauth/settings.json`, which the runtime reads on every request —
the change applies immediately, without a restart. Once a valid settings file
exists it alone decides whether OAuth is enabled and overrides the
`CATENCE_OAUTH_ENABLED`/`CATENCE_PUBLIC_URL` (or `--oauth`/`--public-url`)
startup values; a malformed file fails closed to disabled until the Console
saves a valid one. `catence-data mcp status` reports the effective state and
its `source` (`console`, `environment`, or `disabled`).

- The issuer is the public URL: it must be an absolute `https` URL with no
  query string or fragment (typically the tunnel URL), and it is required when
  OAuth is enabled — the server refuses to start without it (startup values)
  and the Console write rejects it (settings values).
- Clients discover the server through RFC 8414/RFC 9728 metadata served at
  `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource[/mcp]`. Dynamic client registration
  (`POST /oauth/register`, RFC 7591) and client ID metadata documents (CIMD)
  are enabled; PKCE with S256 is enforced.
- The browser consent page lives at `<public-url>/oauth/consent`: it logs in
  with a Console account (username + password, verified against
  `console/accounts.json`) and asks to approve or deny the client. The access
  token carries the account username, and the athlete scope is that account's
  live grants — scoped exactly like an account key.
- While OAuth is enabled, the `401` for a request with no bearer token gains
  an RFC 9728 challenge —
  `WWW-Authenticate: Bearer resource_metadata="<public-url>/.well-known/oauth-protected-resource/mcp"`
  — so OAuth clients can discover the authorization server. A presented but
  invalid token gets `invalid_token` without the challenge instead. Without
  `--oauth` the `401` stays plain on purpose (Mistral connector
  auto-detection).
- Clients that register (DCR) or publish a client ID metadata document with
  `token_endpoint_auth_method: "private_key_jwt"` — OpenAI's ChatGPT/Codex
  connector does — are accepted as public clients: the declaration is
  downgraded to `"none"`, no client secret is issued, and PKCE with S256
  still protects the flow. Catence cannot verify client JWT assertions, so
  the method is never honored as such.
- Authorization-server state (registered clients, authorization codes, tokens)
  lives in `<catalog-home>/oauth/` (directory mode 0700, files 0600).

Note: the `resource_metadata` challenge on token-less `401`s can flip a client
with auth auto-detection (Mistral Work) from bearer to OAuth — smoke-test the
Mistral connector after enabling OAuth. A client that already sends a key
never sees the challenge; it only gets `invalid_token` when the key is wrong.

#### Client matrix

| Client | Setup | Credential |
| --- | --- | --- |
| Mistral Vibe (Work custom connector) | Connectors → Add Connector → Custom MCP Connector, URL `https://<host>/mcp` | Bearer credential (the shared token or a per-account API key) |
| Claude (custom connector) | Authentication: "No sign in"; Request headers: `Authorization: Bearer <key>` | Per-account API key |
| Claude Code (CLI) | `claude mcp add --transport http --header "Authorization: Bearer <key>" <url>` | Per-account API key |
| ChatGPT / Codex | Connector OAuth connect flow | OAuth 2.1 (Console: MCP exposure → OAuth 2.1 sign-in, or `--oauth`) |

Connect HTTP-based clients to `http://127.0.0.1:8787/mcp`. Without the bearer
gate, per-account keys, or OAuth there is **no authentication on the MCP
server itself** — it trusts the caller's `athleteId` parameter — so keep it on
loopback or restrict it at the network layer. For remote access over SSH:
`ssh -L 8787:127.0.0.1:8787 server`.