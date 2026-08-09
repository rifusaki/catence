# MCP activity retrieval contract

This document is the implementation contract for answering questions such as
“what was my latest activity?”, “show me its laps”, and “how did it compare
with recent swims?”. It records the current data behaviour and the dedicated
MCP endpoints that should replace repeated ad-hoc SQL. It is deliberately
source-aware: an agent must not turn plausible Garmin/Intervals coincidences
into asserted facts.

> The only mutation exception is targeted Strava activity, serial activity-batch, or segment-history hydration. It acquires the shared data-directory lock, calls only the Strava GET allowlist, archives responses before normalization, and returns a retryable busy result if another writer owns the lock.

## Non-negotiable rules

- The MCP server is a local, stdio-only consumer of DuckDB and
  registered Parquet files. These endpoints must not call Garmin or
  Intervals.icu, download files, rebuild the retrieval index, or write to the
  database.
- `activity_id` is a logical identity only when it is linked by a
  provider-supplied external ID. `activity_source_id` identifies one
  provider's record and is the correct identifier for source-specific details,
  samples, intervals, and laps.
- Never link two records using time, distance, title, sport, or similar
  metrics. A Garmin and an Intervals activity that look like the same workout
  remain separate unless `link_state` and a shared external ID prove the link.
- Every response includes `data`, `provenance`, `query`, `caveats`, and, when
  appropriate, `nextCursor`. Keep existing result/error conventions:
  `data_sync_in_progress`, `data_unavailable`, and `invalid_request`.
- Source values are retained alongside derived values. Derived fields must name
  their formula and must never overwrite a provider field.
- For a selected activity’s Strava segments, climbs, per-segment grades, or
  KOM/PRs, call `get_activity_segments`. It hydrates the matching Strava
  activity before reading its efforts. Do not report segments as absent unless
  that hydration result is `not_found`, `ambiguous`, unauthorised, throttled,
  or failed—and report that result rather than guessing.

## What exists today

The following are already available and are the authoritative building blocks.
Dedicated activity endpoints must call the same repository/analytics services,
rather than embedding their own DuckDB connection or SQL guard.

| Need | Current interface | Authoritative relation / identifier |
| --- | --- | --- |
| Find a recent activity | `query_read_only_data` on `activities`, `activity_sources`, and `activity_summary_facts` | `activity_id`; then `activity_source_id` |
| Read one logical activity with its sources, summaries, and intervals | `catence://activity/{activityId}` | `activity_id` |
| Read provider summary metrics | `aggregate_data` or `query_read_only_data` on `activity_summaries` | `activity_source_id` |
| Read structured interval chunks | `query_read_only_data` on `activity_interval_facts` | `activity_source_id` |
| Inspect sample-level HR/distance/etc. | `read_series` with `dataset: "activity_samples"` | `activity_source_id` |
| Read an activity’s Strava segments/climbs | `get_activity_segments` | canonical `activity_id` or `activity_source_id` |
| Locate relevant activity text | `search_context` | returned entity/activity identifiers |

`activity_summary_facts` is the provider-specific summary view. It includes
the summary metrics plus `activity_id`, `activity_source_id`, `provider`,
`remote_activity_id`, source artifact hash, activity timestamps, sport, and
name. `canonical_activity_training` contains one selected interpretation per
logical activity (Garmin is preferred when linked); it is useful for
comparison but must not hide provider detail.

`activity_interval_facts` contains structured chunks:

```text
activity_source_id, interval_key, label, start_s, end_s, distance_m,
avg_power, avg_hr, avg_pace, intensity, metrics_json,
activity_id, provider, started_at_utc, sport, name
```

It is not synonymous with device laps. Some providers supply labelled workout
intervals, some supply swim/lap chunks, and some expose an empty split list.
Null `distance_m`, `start_s`, or `end_s` is a genuine “not supplied” value,
not zero. `metrics_json` remains the source-specific escape hatch.

`activity_samples` is a Parquet-backed time series available only through
`read_series`/`aggregate_data`. It has `timestamp_utc`, `elapsed_s`,
`distance_m`, `heart_rate_bpm`, and other nullable sensor fields. It cannot
be used to introduce an arbitrary Parquet path.

## Swim facts and tools

`swim_length_facts` contains only explicit provider-supplied length records.
Catence does not infer a 25 m/50 m length boundary, rest, or pace from Garmin
sample points when distance disappears after the opening sample. An empty
length result therefore means *not supplied*, not no lengths swum.

`swim_set_facts` retains source-specific grouped work:

- `garmin_detected` comes from Garmin split summaries and may have a supplied
  duration/HR but no usable distance;
- `intervals_auto` parses Intervals.icu labels such as `12x 52m 154bpm` into
  `reps`, `rep_distance_m`, total distance, and mean HR. It remains an
  auto-detected block, not a manually pressed set, and pace/work/rest stay
  null unless supplied.

`activity_interval_facts` now includes `duration_s`, `moving_s`, and
`source_type` for those source rows. `canonical_activity_facts` exposes the
unmodified Garmin and Intervals values beside each selected field, the source
that won precedence, their distance difference, and quality flags.

Use `get_swim_laps({ activityId, provider? })` for one source or linked
activity. A source ID is resolved exactly; a logical activity ID returns all
linked swim sources. Use `swim_progress_report({ startDate, endDate,
poolLengthM? })` for Garmin-native summary comparisons. The report never
creates a pace trend from `moving_s / distance_m`, and it returns
data-completeness notes for per-length pace.

Ingestion flags implausible pool settings, zero speed/cadence long pool
sessions, active-length/distance mismatches, linked-provider distance
disagreements, and missing explicit length records. Flags are caveats; they
never overwrite or discard a provider's source values.

## Current investigation procedure

Use this procedure until the endpoints below exist.

1. Check `catence_status`. If the sync snapshot is unavailable, report the MCP
   error; do not retry by opening the database for writing.
2. List provider records from newest to oldest with `activities` joined to
   `activity_sources` and, where needed, `activity_summary_facts`. Include
   both the logical and source IDs in the result.
3. For one selected source, query `activity_interval_facts` ordered by
   `start_s`. Do not use a time/distance heuristic to select a different
   source.
4. If a provider’s interval rows are empty or all structural fields are null,
   say that detailed splits were not supplied by that imported endpoint. A
   summary field such as Garmin's lap count or fastest split is still useful,
   but it does **not** reconstruct per-lap records.
5. If numerical detail is required, use `read_series` for the selected
   `activity_source_id`; include its resolution/downsampling caveat. The
   original activity file may exist in the raw archive, but raw archives are
   not exposed directly to MCP in this release.

### Segment calculations

For an interval with positive `distance_m` and both times present, an agent
may add the following *derived* fields:

```text
duration_s = end_s - start_s
pace_s_per_100m = 100 * duration_s / distance_m
```

Only emit `pace_s_per_100m` when `duration_s > 0` and `distance_m > 0`.
Retain the original `avg_pace` separately and do not infer its unit when the
provider does not document/populate it. A no-distance chunk may be described
as `no_distance_segment`; calling it a recovery/rest requires a source label
or a clearly labelled user interpretation. If the sum of chunk distances
differs from the activity summary, report both values and the difference.

## Proposed dedicated MCP endpoints

These endpoints are drafts, not registered tools yet. Add them incrementally
only after their shared service methods and fixture tests exist.

## Implemented fitness and hydration endpoints

- `describe_dataset(dataset)` returns one cataloged schema and its coverage. `training_metric_observations` also reports its observed sports, metric names, units, and source types.
- `get_ftp_history`, `get_vo2max_history`, `power_curve_trend`, and `power_coverage_report` read normalized, source-aware fitness facts. Power tools require an explicit sport or sport family, use `power_bests`/`power_best_facts` for FIT-derived duration values, and do not treat sparse `avg_power` summaries as coverage. `get_vo2max_history` does not default to cycling: omission returns available sports and requires an explicit choice; Garmin running VO₂max may be labelled `generic`.
- `find_activities` is implemented for compact, canonical, paginated activity/race discovery by sport, distance, name, and date. Its race flags are transparent heuristics, not provider-confirmed race metadata.
- `get_activity_segments` is the required segment/climb path. It performs the
  targeted Strava hydration before returning the persisted effort and segment
  facts; an empty result must be interpreted alongside its hydration status.
- `latest_cycling_activities` returns Garmin source records to avoid silently double-counting linked Intervals summaries; optional multisport parents are explicitly flagged.
- `cycling_progress_report` composes the preceding read-only outputs with monthly canonical volume/load. It is descriptive, not a physiological model.
- `hydrate_recent_strava_activities` accepts an explicit list or a bounded date/sport window and awaits each write in sequence. Its unmatched output includes the exact Strava search window and safe-match rejection diagnostics.

### Power investigation procedure

For a question about running or cycling power, do not begin with
`canonical_activities.avg_power`: it is an activity-summary field and can be
null even when the FIT stream has power. Instead:

1. Call `describe_dataset` for `power_bests` and use `power_coverage_report`
   with an explicit `sport` or `sportFamily` to establish coverage and every
   available duration.
2. Use `power_curve_trend` with the same selector and
   `sourceQuality: "garmin_fit_derived"` for comparable monthly curve bests.
3. Inspect `activity_samples` only for a selected `activity_source_id` when a
   specific extreme needs validation. Raw sample reads are paginated and are
   not evidence that the global power dataset is absent.

### `list_recent_activities`

Purpose: answer “what is my latest activity?” without requiring the agent to
invent joins, provider precedence, or identifier handling.

Input:

```ts
{
  before?: string,              // ISO timestamp; exclusive cursor anchor
  after?: string,               // ISO timestamp; inclusive
  provider?: "garmin" | "intervals",
  sport?: string,
  sourceMode?: "source" | "logical", // default: "source"
  limit?: number,               // 1–100; default: 20
  cursor?: string
}
```

`sourceMode: "source"` is the default because it never conceals an unlinked
provider record. It returns one provider source per item. `sourceMode:
"logical"` returns an activity plus all its source records only when the
database already has that logical relationship; unlinked records remain
separate items. Both modes sort by `started_at_utc DESC`, then stable source
identity. Cursor contents are opaque, signed/validated query state—not a raw
SQL offset.

Each item should include:

```ts
{
  activityId: string,
  activitySourceId: string,
  provider: "garmin" | "intervals",
  remoteActivityId: string,
  externalId: string | null,
  linkState: string,
  startedAtUtc: string | null,
  startedAtLocal: string | null,
  timezone: string | null,
  sport: string | null,
  name: string | null,
  summary: {
    distanceM: number | null,
    movingS: number | null,
    elapsedS: number | null,
    avgHr: number | null,
    maxHr: number | null,
    trainingLoad: number | null
  } | null,
  availability: { intervals: boolean, samples: boolean }
}
```

The query is a read-only projection of `activities`, `activity_sources`,
`activity_summary_facts`, and `stream_manifest`. It must not use
`canonical_activity_training` to suppress a Garmin source. Provenance names
the selected relations and source artifact hash where available.

### `get_activity_detail`

Purpose: return the compact, authoritative detail an agent needs after a
selection from `list_recent_activities`.

Input is exactly one of:

```ts
{ activitySourceId: string, include?: ["summary", "intervals", "availability"] }
// or
{ activityId: string, include?: ["summary", "intervals", "availability"] }
```

`activitySourceId` returns exactly that provider record. `activityId` returns
the logical activity plus **all** linked sources; it never selects a “best”
source silently. The default includes `summary` and `availability`, not every
interval. Intervals are limited to 500 items and receive deterministic cursor
pagination. A compact response should contain activity identity/timestamps,
source identities and external IDs, all available provider summaries, and:

```ts
availability: {
  intervalCount: number,
  intervalDetailsAvailable: boolean,
  stream: { available: boolean, rowCount?: string, columns?: string[] },
  originalArchiveRecorded: boolean
}
```

`originalArchiveRecorded` only states that a raw object/manifest exists. It
does not expose a filesystem path or claim that FIT parsing supplied laps.
`include: ["intervals"]` follows the segment contract below.

### `list_activity_segments`

Purpose: replace the manual interval query used for lap/interval questions.
It should have a neutral name because source “intervals”, swim laps, and
device splits have different meanings.

Input:

```ts
{
  activitySourceId: string,
  kind?: "all" | "structured_interval" | "lap_or_split", // default: "all"
  includeDerived?: boolean,  // default: true
  limit?: number,            // 1–500; default: 100
  cursor?: string
}
```

`kind` filters only by explicit source classification. It must return an
empty result with `lap_or_split_available: false` when the provider supplied
no detailed split records; it must not manufacture laps from sample points.

For each item return source fields (`intervalKey`, `label`, `startS`, `endS`,
`distanceM`, `avgHr`, `avgPower`, `avgPace`, `intensity`, and optionally
`metricsJson`) plus safe derived fields:

```ts
{
  derived: {
    durationS: number | null,
    paceSPer100m: number | null,
    distanceClass: "positive_distance" | "no_distance" | "unknown"
  }
}
```

The top-level result includes total supplied distance, total derived distance,
summary distance, and their difference. It must explicitly disclose whether
the response is made of structured intervals, provider laps/splits, or both.

### `read_activity_stream`

Purpose: make selected-source sample inspection straightforward while retaining
the existing bounded stream rules.

Input:

```ts
{
  activitySourceId: string,
  metrics: Array<"elapsed_s" | "distance_m" | "heart_rate_bpm" |
                 "power_w" | "cadence_rpm" | "speed_mps" | "temperature_c">,
  resolution?: "raw" | "1m" | "5m" | "15m" | "auto",
  startElapsedS?: number,
  endElapsedS?: number,
  pageSize?: number,
  cursor?: string
}
```

This is a source-ID wrapper over `read_series({ dataset: "activity_samples" })`.
It inherits the 1,000-point page limit, cursor format, automatic downsampling,
manifest-only Parquet access, and null handling. It returns no data—not an
error—when the source has no registered stream, with a caveat explaining that
sample availability is provider/activity-specific.

## Intended agent behaviour

For “how did this go in the context of my recent swims?” an agent should:

1. Use `list_recent_activities` filtered to swimming to identify the selected
   source and comparable source records.
2. Use `get_activity_detail` for the selected source. Prefer canonical
   Intervals training values only when the logical activity is strongly linked;
   otherwise state the provider used.
3. Use `list_activity_segments` only for set/lap questions. Compute pace using
   the documented formula, name it as derived, and do not call unlabelled
   sections “recovery” as a fact.
4. Use `read_activity_stream` when the summary/segments cannot answer a
   question about HR evolution, temperature, or other sample-level behaviour.
5. State missing data and provenance in the answer. Do not imply that an empty
   Garmin split list means no laps occurred—only that detailed split records
   were not returned by the imported endpoint.

## Implementation order and acceptance criteria

1. Add repository methods that return typed source-first activity records and
   manifest availability. Keep SQL there; MCP handlers remain thin.
2. Implement `list_recent_activities`, including stable ordering and tamper-
   resistant cursor validation.
3. Implement `get_activity_detail` and `list_activity_segments` against the
   repository methods. Reuse the existing JSON-safe result/error envelope.
4. Add `read_activity_stream` as a validated adapter to `AnalyticsService`;
   do not duplicate downsampling or Parquet path checks.
5. Add Zod schemas and one independent module/test file per tool. Update the
   catalog/README once the tools are registered.

Fixture tests must cover:

- two unlinked Garmin/Intervals records with similar timestamps and distances;
  list results remain distinct;
- a truly strong-ID-linked activity; detail returns both sources without
  concealing either;
- labelled intervals, unlabelled positive-distance chunks, and no-distance
  chunks; pace is derived only when valid;
- a Garmin summary with lap count/fastest split but an empty split list;
  `lap_or_split_available` is false and no laps are invented;
- no stream manifest, missing Parquet file, and a valid registered stream;
- pagination, malformed/tampered cursors, limits, and read-only snapshot
  errors;
- response provenance and caveats for every branch.
