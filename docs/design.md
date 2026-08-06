# Catence

This is the first design document for Catence, a local MCP server for AI agents to interact with health and fitness data.

Even though a great deal of code is written by an agent, the base architecture remains human-driven. However, since I am quite a beginner this means it may actually be somewhat less efficient, but as IBM famously said (somewhere), machine can't make decisions.

## Design

The project consists of the following stages:

1. Data fetching
2. Normalization and storage
3. Queries, tools and methods
4. Serving

## Source-layer boundaries

The repository is one publishable package, organized by logical layer rather
than deployment unit:

```text
src/contracts/   shared staging, runtime-path, and storage-port contracts
        ↑
src/core/        catalog, query guard, analytics, retrieval, and runtime policy
        ↑
src/elt/         provider clients, artifact/archive storage, DuckDB, Parquet,
                 normalization, and management use cases
        ↑
src/interfaces/  CLI and MCP transport adapters and executable entry points
```

`core` imports contracts and standard-library capabilities only: it has no
DuckDB, provider SDK, or transport dependency. `elt` implements storage and
provider concerns and may invoke core use cases such as retrieval-index
building. `interfaces` parses transport-specific input, invokes these use
cases, and serializes the response. The Python Garmin and Strava workers remain
under `python/catence/` so their stable `uv` module path and npm distribution
contract remain intact; they are an ELT component and never write DuckDB.

### 1. Data fetching

Garmin Connect provides the complete local record. Intervals.icu contributes only its separately named activity-analysis values (for example training load, RPE, feel, and weighted power). Strava is a deliberately sparse, targeted source for current gear and selected activity segment enrichment.

For Garmin, we will use [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) as it is the most mature and widely used library for this purpose. On the Intervals.icu side, the best option available right now is [node-intervals-icue](https://github.com/paladini/node-intervals-icu).

### 2. Normalization and storage

Catence is DuckDB-first. It is a local, read-only ingestion pipeline before it
becomes an MCP server: raw source artifacts, normalized relational facts, and
high-frequency samples have deliberately different storage responsibilities.

```text
Intervals.icu / Garmin Connect / targeted Strava
        ↓
immutable raw JSON and original activity files
        ↓
DuckDB catalogue and provenance records
        ↓
Parquet activity-stream lake, queried through DuckDB views
```

Runtime data lives in the ignored `.catence/` directory:

- `catence.duckdb` contains normalized entities, ingestion state, source
  provenance, and future-query views.
- `raw/` contains content-addressed JSON responses and original downloaded
  activity files.
- `lake/activity_samples/` contains one Parquet stream file per provider
  activity, partitioned by provider/year/month.
- `staging/` contains versioned Garmin JSONL batches before the Node importer
  commits them to DuckDB.

Node/TypeScript owns the DuckDB connection and all database writes. It fetches
Intervals.icu directly and imports Garmin staging batches. Python owns Garmin
authentication, API extraction, FIT parsing, and Parquet generation; it never
opens the DuckDB database for writing.

Every provider call is on an explicit GET/download allowlist. Syncs archive
responses before normalization, record work-item and error state, continue past
an individual failed endpoint/activity, and can be safely rerun because source
artifacts are content-addressed and normalized rows have stable keys.

The first manual sync uses the previous 12 months only when there is no local
normalized coverage. Afterwards, normal syncs are cursor-backed: daily facts
reconcile the most recent three days and activity discovery reconciles the most
recent fourteen. Activity child endpoints and files are fetched only for new or
changed activity summaries. Historical imports remain explicit backfill
commands; there is no scheduler or provider mutation in this phase.

Normalized tables preserve provenance rather than force an early merge:

- Activities remain provider-specific through `activity_sources`. Provider external IDs are strong links; an auto-link is allowed only for one sport-compatible candidate within 90 seconds and tight duration/distance tolerances, while ambiguity and virtual/indoor conflicts remain unlinked. Garmin is the canonical original activity detail source. Intervals training load, RPE, feel, and related calculations remain separately named analysis fields; Strava is never canonical.
- Daily health observations retain provider/source values in `daily_metrics`,
  while the default `daily_health` projection selects Garmin for every date
  where Garmin has health facts (another provider is a whole-day fallback).
  Nutrition includes daily macro/hydration totals and individual food/meal
  items, in addition to the complete archived payload.
- Plans, workouts, events, routes, gear, devices, goals, achievements,
  messages, and provider-specific data are represented as normalized source and
  domain entities with stable query views and `extension_json` for fields the
  common model does not yet name.
- Per-sample GPS, power, heart rate, cadence, speed, altitude, temperature, and
  grade data are stored as nullable Parquet columns; uncommon sensors are kept
  in per-sample JSON and the original activity archive remains recoverable.

This boundary is intentional: MCP tools read DuckDB views and Parquet-backed
analytical queries, while the local retrieval index contains curated summaries
and notes rather than raw activity streams or source dumps.

### 3. Queries, tools and methods

The MCP process is a separate stdio consumer. Ordinary tools and resources open DuckDB `READ_ONLY` snapshots. The only write capabilities are the explicit `hydrate_strava_activity`, serial `hydrate_recent_strava_activities`, and `hydrate_strava_segment_history` tools: each acquires the shared data-directory lock, calls only the Strava GET allowlist, archives responses before normalization, commits, and releases the lock. If another writer owns it, the result is retryable `data_sync_in_progress`.

The query layer has four shared pieces:

1. A catalog describes every allowed dataset, field, unit, provenance field,
   filter, and grouping. The catalog includes activities, activity sources and
   summaries/intervals, health/daily facts, nutrition days/items, all domain
   projections, source entities, and activity samples.
2. The repository reads stream data only from `stream_manifest`. It resolves
   each recorded relative Parquet path under `lake/activity_samples`, verifies
   it exists under that directory, and otherwise produces an empty typed
   relation. No MCP argument can introduce a filesystem path.
3. Analytics services power both general tools and any future dedicated fitness
   tool. They provide bounded series reads, declarative aggregation,
   descriptive statistics/correlations/trends, and OLS, Theil–Sen, quadratic,
   or cubic fitting. These are descriptive fits, not physiological or
   sport-performance models.
4. A SQL guard offers a limited lower-level fallback for questions that do not
   yet justify a dedicated tool. It accepts one parameterized `SELECT` or
   `WITH … SELECT` over cataloged views, inspects its resolved table names,
   rejects filesystem/extension/mutation statements, interrupts after four
   seconds, and caps output at 500 rows / 512 KB.

`read_series` returns a maximum of 1,000 points per page. Dense activity
streams default to minute aggregation on the first `auto` page; raw data stays
available through the same bounded interface with a deterministic query-bound
cursor. This lets an agent first answer an HRV evolution or training-load
question safely, then request a narrower/raw series only when it is useful.

### 4. Serving and retrieval

The server currently exposes `catence_status`, `describe_data`, `read_series`,
`aggregate_data`, `analyze_series`, `fit_series_model`,
`query_read_only_data`, `search_context`, `hydrate_strava_activity`, `hydrate_recent_strava_activities`, and `hydrate_strava_segment_history`, plus resources for status,
catalog, a single activity, and a date-range summary.

`catence-data build-retrieval-index` explicitly generates `retrieval_documents` and
`retrieval_index_state` in DuckDB. Documents draw from activity labels and key
summary facts, interval labels, routes/messages, planned workouts/events,
weekly training summaries, nutrition daily summaries, and food names. They do
not include sample streams, GPS paths, source JSON, raw nutrition payloads, or
activity files. Sync marks the index stale; rebuilding is idempotent and records
the raw-data watermark.

When the DuckDB FTS extension is already available locally, the build uses it;
otherwise—and without attempting installation—search falls back to normalized
keyword matching. `catence_status` reports the active retrieval mode. Embeddings
and vector search remain deliberately deferred until keyword/full-text results
prove inadequate.

Dedicated tools should be added gradually only when recurring questions have
stable semantics and cannot be expressed clearly by these primitives. They must
call the same repository/analytics services, preserving provenance and the
read-only boundary.

### Distribution MVP and future web hosts

The public npm distribution is named `catence`. It exports two commands:
`catence`, the direct stdio-only server, and `catence-data`, the management CLI. Both accept an explicit
data directory; the server never initializes or runs a general sync. Ordinary queries never write, while the declared Strava hydration tools use the shared locked writer path.
This makes one local data snapshot usable by multiple agents without relying on
their current working directory or sharing provider credentials.

The package includes the Python Garmin and Strava workers and its `uv` project metadata so
the management CLI remains functional after installation. Its Python virtual
environment belongs under the selected data directory, rather than the npm
installation directory.

Streamable HTTP is deliberately not part of this MVP. An Open WebUI-style
integration must be a separately authenticated hosting adapter that assigns an
isolated data directory per user and retains all existing query/path guards.
It must preserve the local server narrow writer contract, provider GET allowlist, and no-arbitrary-filesystem rule.

The source-aware contract for activity discovery, details, laps/segments, and
sample streams is documented in [MCP activity retrieval](mcp-activity-retrieval.md).
