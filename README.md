# Catence

> Local fitness-data extraction and analysis for Garmin Connect, Intervals.icu, and targeted Strava enrichment.

Catence keeps raw provider artifacts, a DuckDB catalogue, a Parquet activity-stream lake, and a local read-only MCP server for analytical access. The distributable npm package is `catence`: its `catence` command runs the server, while `catence-data` manages the local data store.

## MVP: install once, connect from any local agent

After publishing `catence` to npm, create a data store at an **absolute** path. Keeping it outside any individual repository means Codex, OpenCode, and other clients read the same private snapshot.

```sh
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data init
```

Import data with the management CLI, not the MCP server:

```sh
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data sync --provider intervals
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data build-retrieval-index
```

The MCP command is intentionally just one process invocation:

```sh
npx --yes catence --data-dir /absolute/path/to/catence-data
```

It writes protocol traffic only to stdout; diagnostics go to stderr. `--data-dir` takes precedence over `CATENCE_DATA_DIR`. If neither is supplied, the legacy default remains `.catence/` under the process working directory, which is useful for source development but not recommended for agent configuration.

See [agent installation](docs/agent-installation.md) for copy-paste Codex and OpenCode configuration, a global-install alternative, the [future APM producer ramp](docs/agent-installation.md#apm-producer-ramp-future), and the HTTP-hosting boundary.

## Requirements

- Node.js 22+
- Python 3.12+ with [uv](https://docs.astral.sh/uv/)

Node is enough to run ordinary MCP reads against an existing data store. `uv` and Python are required for Garmin imports and targeted Strava enrichment; the published package carries the Garmin worker and writes its virtual environment inside the selected data directory.

## Setup

```sh
npm install
uv sync
cp .env.example .env
```

Populate the provider credentials you want to use. Runtime data defaults to `.catence/`, which is ignored by Git.

## Commands

```sh
npm run catence-data -- status
npm run catence-data -- sync --provider intervals
npm run catence-data -- sync --provider garmin --from 2025-07-29
npm run catence-data -- sync --provider strava
npm run catence-data -- sync --provider all
npm run catence-data -- retry --run <run-id>
npm run catence-data -- backfill --from 2020-01-01
npm run catence-data -- build-retrieval-index
npm run mcp
```

All provider calls are protected by a read-only endpoint allowlist. A sync continues after individual extraction failures and records them for `retry`.

The first ordinary sync uses the historical fallback only when no normalized
coverage exists. After that, `sync` is incremental: Garmin daily facts use a
three-day overlap, activities use a fourteen-day overlap, and unchanged
activities do not re-download their detail endpoints, original files, or
streams. `--from` and `backfill` are explicit ranges and do not move the
incremental cursor. `catence-data status` reports each provider cursor and its next
effective start date.

Build the retrieval index after a completed sync. It contains compact, derived
activity/plan/nutrition context only—not GPS tracks, sample streams, raw JSON,
or original files. A later sync marks it stale again.

## MCP

`npm run mcp` launches a local stdio server from this checkout. The package entry point is `catence --data-dir /absolute/path/to/catence-data`. Ordinary analytical tools and resources open `catence.duckdb` with DuckDB `READ_ONLY` mode for each request. The only MCP writes are `hydrate_strava_activity` and `hydrate_strava_segment_history`; they take the shared data-directory write lock, call only the Strava GET allowlist, archive before normalization, commit, and release the lock. If any writer owns the lock, the enrichment call returns retryable `data_sync_in_progress`; ordinary reads remain read-only snapshots.

For development from this repository, invoke it with an explicit data path:

```sh
npm run mcp -- --data-dir /absolute/path/to/catence-data
```

For an npm-installed agent, use the `npx` configuration in [agent installation](docs/agent-installation.md) instead. Do not put Intervals, Garmin, or Strava credentials in an MCP client configuration: those are needed by the management process only.

The ordinary tool set is analytical; the only mutation-capable additions are `hydrate_strava_activity` and `hydrate_strava_segment_history`:

- `catence_status` and `describe_data` expose coverage, provenance, units, and catalog constraints.
- `read_series`, `aggregate_data`, `analyze_series`, and `fit_series_model` cover bounded time-series work. `read_series` automatically aggregates dense streams and returns a deterministic cursor for later pages.
- `search_context` finds generated context and points to the authoritative follow-up tool.
- `query_read_only_data` is the escape hatch for novel questions. It permits one parameterized `SELECT`/`WITH … SELECT` against cataloged views only, with a 500-row, 512 KB, and four-second limit. It rejects comments, multiple statements, mutations/DDL, extension commands, `COPY`/`ATTACH`, and filesystem table functions.

Examples:

```text
analyze_series({ dataset: "daily_health", metrics: ["hrv_ms"],
  startDate: "2026-01-01", endDate: "2026-03-31", resolution: "day",
  analysis: "theil_sen_trend" })

fit_series_model({ dataset: "daily_health", metrics: ["hrv_ms"],
  startDate: "2026-01-01", endDate: "2026-03-31", resolution: "day",
  model: "ols_linear" })
```

## Targeted Strava enrichment

Strava is intentionally sparse and on demand. It is not an activity backfill or a canonical activity source. Garmin remains the original/canonical activity detail source; Intervals contributes separately named analysis values such as training load, RPE, feel, and weighted power.

Connect it from a terminal that has the registered Strava application credentials. The first command prints an approval URL; after approving it, pass the returned authorization code to the second command.

```sh
export STRAVA_CLIENT_ID=...
export STRAVA_CLIENT_SECRET=...
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data auth strava
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data auth strava --code <authorization-code>
```

Catence requests `read`, `activity:read_all`, and `read_all`. Credentials and the rotating OAuth token are stored only in `<data-dir>/secrets/strava.json`, mode `0600`; they are never stored in DuckDB, raw artifacts, normal configuration, logs, or MCP output. Remove the local connection with:

```sh
catence-data --data-dir /absolute/path/to/catence-data disconnect strava
```

For local, let's go with

```sh
(knead-garmin) rifusaki@rifuAir catence % npm run catence-data auth strava

> catence@0.1.0 catence-data
> tsx src/interfaces/cli/main.ts auth strava

{
  "authorizationUrl": [go in here],
  "scopes": [
    "read",
    "activity:read_all",
    "read_all"
  ],
  "status": "authorization_required"
}
(knead-garmin) rifusaki@rifuAir catence % npm run catence-data -- auth strava --code [code]
```

`sync --provider strava` refreshes only the current athlete bike and shoe records. An MCP agent can then use `hydrate_strava_activity` for one existing Catence activity/source ID. Catence searches a narrow time window, applies the audited matcher, and persists the matched activity detail, assigned gear, segment efforts, and embedded segment facts. `hydrate_strava_segment_history` accepts one persisted segment ID and retrieves only that segment detail plus the authenticated athlete historic efforts. Completed enrichment is cached unless `refresh` is set. A throttle or interruption returns saved `partial` state with its continuation page, so the next request resumes rather than discarding existing rows.

Segment facts include name, length, grades, climb category, elevation, privacy, hazard, and raw `starred` state. Strava public segment data does not expose verification, so Catence always reports it as unavailable and never guesses missing power, speed, or verification data.

## Identity, writes, and local limits

Provider external IDs are strong activity links. Otherwise Catence auto-links only one compatible candidate: the sport family must match, starts must be within 90 seconds, moving duration must differ by at most `max(120 seconds, 5%)`, and distance by at most `max(200 meters, 2.5%)`. Ambiguous, incomplete, conflicting, or virtual/indoor-incompatible cases remain unlinked. Corrections are explicit and auditable:

```sh
catence-data --data-dir /absolute/path/to/catence-data activity link --source intervals:123 --activity garmin:456
catence-data --data-dir /absolute/path/to/catence-data activity unlink --source intervals:123
```

The optional `<data-dir>/config.json` configures in-process MCP limits. Missing, blank, `{}`, omitted values, and `null` mean unlimited; existing SQL/result/time safety limits still apply. Every MCP data-bearing tool and resource is guarded. Remote Strava headers and HTTP 429 outcomes always take priority; provider budgets only lower local use.

```json
{
  "mcp": {
    "rateLimits": {
      "server": null,
      "tools": { "*": null },
      "resources": { "*": null }
    }
  },
  "providers": {
    "strava": {
      "budget": {
        "maxConcurrentRequests": null,
        "readRequestsPer15Minutes": null,
        "readRequestsPerDay": null
      }
    }
  }
}
```
