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
npm run catence-data -- backfill --provider garmin --from 2026-07-01 --refresh
npm run catence-data -- build-retrieval-index
npm run mcp
```

All provider calls are protected by a read-only endpoint allowlist. Garmin supplies canonical activity and health data; Intervals syncs only its activity-summary analysis values, not duplicate health, files, streams, or unrelated account data. A sync continues after individual extraction failures and records them for `retry`.

The first ordinary sync uses the historical fallback only when no normalized
coverage exists. After that, `sync` is incremental: Garmin daily facts use a
three-day overlap, activities use a fourteen-day overlap, and unchanged
activities do not re-download their detail endpoints, original files, or
streams. `--from` and `backfill` are explicit ranges and do not move the
incremental cursor. `catence-data status` reports each provider cursor and its next
effective start date. A normal `backfill` stops before each provider's newest
local daily/activity source date, so it fetches only older, uncovered history;
it also skips current account and collection endpoints. A fully covered range
returns as skipped without contacting the provider. `backfill --refresh` is the
explicit override: it re-fetches and upserts the complete selected range,
including every Garmin activity's details, files, and streams. Backfills also
fetch Garmin's historical cycling FTP setting range, retaining each daily
setting separately from activity-level FTP and the current-only setting. They
preserve archived raw artifacts and do not delete data merely absent from a
later provider payload.

Build the retrieval index after a completed sync. It contains compact, derived
activity/plan/nutrition context only—not GPS tracks, sample streams, raw JSON,
or original files. A later sync marks it stale again.

## MCP

`npm run mcp` launches a local stdio server from this checkout. The package entry point is `catence --data-dir /absolute/path/to/catence-data`. Ordinary analytical tools and resources open `catence.duckdb` with DuckDB `READ_ONLY` mode for each request. The only MCP writes are `get_activity_segments` (which hydrates before reading), `hydrate_strava_activity`, serial `hydrate_recent_strava_activities`, and `hydrate_strava_segment_history`; they take the shared data-directory write lock, call only the Strava GET allowlist, archive before normalization, commit, and release the lock. If any writer owns the lock, the enrichment call returns retryable `data_sync_in_progress`; ordinary reads remain read-only snapshots.

For development from this repository, invoke it with an explicit data path:

```sh
npm run mcp -- --data-dir /absolute/path/to/catence-data
```

For an npm-installed agent, use the `npx` configuration in [agent installation](docs/agent-installation.md) instead. Do not put Intervals, Garmin, or Strava credentials in an MCP client configuration: those are needed by the management process only.

The ordinary tool set is analytical; the only mutation-capable additions are `get_activity_segments`, `hydrate_strava_activity`, serial `hydrate_recent_strava_activities`, and `hydrate_strava_segment_history`:

- `catence_status` and `describe_data` expose coverage, provenance, units, and catalog constraints.
- `describe_dataset` is the compact schema browser for one cataloged dataset, avoiding exploratory SQL just to find field names. `training_metric_observations` includes observed sports, metric names, units, and source types.
- `read_series`, `aggregate_data`, `analyze_series`, and `fit_series_model` cover bounded time-series work. `read_series` automatically aggregates dense streams and returns deterministic cursor pagination with `returnedRows`, `totalRows`, and `truncated`.
- `get_ftp_history`, `get_vo2max_history`, `power_curve_trend`, `power_coverage_report`, `latest_cycling_activities`, and `cycling_progress_report` expose source-aware fitness projections without JSON-path or array-index SQL. Power-curve and coverage requests require an explicit sport or sport family, and distinguish FIT-derived duration bests from activity-summary average power. VO₂max requires an explicit sport for observations; an omitted sport returns the available-sport summary, because Garmin often stores a running estimate as `generic`.
- `find_activities` is the authoritative, paginated way to discover activities or likely races by sport, distance, name, and date.
- `get_activity_segments` is the required route for a selected activity’s segments, climbs, per-segment grades, or KOM/PRs. It hydrates the matching Strava activity before reading the persisted efforts, so an agent must report its hydration outcome rather than treating unhydrated segment data as absent.
- `search_context` finds generated context and prominently identifies a stale index and its direct-query alternative.
- `query_read_only_data` is the escape hatch for novel questions. It permits one parameterized `SELECT`/`WITH … SELECT` against cataloged views only, with a 500-row per-page, safe response-size, and four-second limit. It returns deterministic pagination plus `returnedRows`, `totalRows`, `truncated`, and `nextCursor`, and rejects comments, multiple statements, mutations/DDL, extension commands, `COPY`/`ATTACH`, and filesystem table functions.

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

`sync --provider strava` refreshes only the current athlete bike and shoe records. For a selected activity’s segments or climbs, an MCP agent uses `get_activity_segments`; it hydrates the matching Strava activity itself before reading efforts. `hydrate_strava_activity` remains available for direct enrichment, and `hydrate_recent_strava_activities` accepts an explicit list or bounded date/sport window. The batch tool processes writes serially and reports every match, miss, ambiguity, and skip. Catence retrieves an already-linked Strava source, or an explicitly Strava-qualified ID, directly; otherwise it searches a narrow time window and applies the audited matcher. Garmin multisport parents hydrate their non-transition child activities individually. The matcher uses sport families, start time, elapsed duration, and distance; it deliberately does not reject on Strava's indoor/virtual classification. A direct lookup that is no longer available falls back to that safe matcher. Unmatched results include the search window, returned/qualified candidate counts, rejection reasons, and practical next checks. It then persists the activity detail, assigned gear, segment efforts, and embedded segment facts. `hydrate_strava_segment_history` accepts one persisted segment ID and retrieves only that segment detail plus the authenticated athlete historic efforts. Completed enrichment is cached unless `refresh` is set. A throttle or interruption returns saved `partial` state with its continuation page, so the next request resumes rather than discarding existing rows.

Segment facts include name, length, grades, climb category, elevation, privacy, hazard, and raw `starred` state. Strava public segment data does not expose verification, so Catence always reports it as unavailable and never guesses missing power, speed, or verification data.

## Identity, writes, and local limits

Provider external IDs are strong activity links. The general cross-provider activity linker auto-links only one compatible candidate: the sport family must match, starts must be within 90 seconds, moving duration must differ by at most `max(120 seconds, 5%)`, and distance by at most `max(200 meters, 2.5%)`. Its virtual/indoor safeguard is separate from Strava hydration, which uses elapsed duration and does not reject on that classification. Corrections are explicit and auditable:

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
