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
data tool. This is intentional: a shared agent may access the stores you
configured, but no tool implicitly aggregates or crosses between athletes.

## Multi-athlete catalog

Catence is designed to serve **several isolated athlete stores** from one
shared server. Each store has its own DuckDB, raw data, and tokens, so
athletes never leak into each other.

### MCP behavior

- `list_athletes` returns `{ defaultAthleteId, athletes: [{ id, label }] }`.
- Every personal-data tool in catalog mode requires an `athleteId` input (the
  server auto-prepends it to every tool schema). Calls without it fail with
  `athleteId is required. Call list_athletes to inspect the configured catalog.`
- The `catence://athletes` resource returns the same catalog.
- Rate limits are tracked **per athlete**: each athlete has its own sliding
  window for server, tool, and resource limits.
- MCP responses carry an `athlete` field identifying which store served them.

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

- `GET /api/v1/athletes` returns IDs and labels only.
- `GET /api/v1/dashboard` requires `athleteId`, for example
  `http://127.0.0.1:8787/api/v1/dashboard?athleteId=alex&days=28` (`endDate`
  is an optional `YYYY-MM-DD`; `days` ranges 1-90 and defaults to 28).
- Browser origins must be listed with `--allow-origin` (repeatable). The
  packaged Console instead proxies the dashboard through its authenticated
  same-origin route.

Connect HTTP-based clients to `http://127.0.0.1:8787/mcp`. There is **no
authentication on the MCP server itself** — it trusts the caller's `athleteId`
parameter — so keep it on loopback or restrict it at the network layer. For
remote access over SSH: `ssh -L 8787:127.0.0.1:8787 server`.