# MCP activity retrieval contract

This document is the implementation contract for answering questions. It records the current data behaviour and the dedicated MCP endpoints that should replace repeated ad-hoc SQL.

The only mutation exception is targeted Strava activity, serial activity-batch, or segment-history hydration. It acquires the shared data-directory lock, calls only the Strava GET allowlist, archives responses before normalization, and returns a retryable busy result if another writer owns the lock.

## Basics

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

## Investigation procedure

1. Check `catence_status`. If the sync snapshot is unavailable, report the MCP
   error; do not retry by opening the database for writing.
2. Use `find_activities` to list provider records filtered by sport, distance,
   name, or date. Results are paginated and return both logical and source IDs.
3. For a selected source, call `get_activity_segments` for intervals, laps,
   or structured splits — it automatically hydrates the matching Strava activity
   when needed.
4. If a provider's interval rows are empty or all structural fields are null,
   say that detailed splits were not supplied by that imported endpoint. A
   summary field such as Garmin's lap count or fastest split is still useful,
   but it does **not** reconstruct per-lap records.
5. If numerical detail is required, use `read_series` for the selected
   `activity_source_id`; include its resolution/downsampling caveat. The
   original activity file may exist in the raw archive, but raw archives are
   not exposed directly to MCP in this release.
6. For aerobic decoupling or grade-adjusted pace, call `activity_decoupling`.
   For race-readiness questions, call `readiness_baseline` first.

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

## Activity discovery, detail, and stream endpoints

The originally proposed `list_recent_activities`, `get_activity_detail`,
`list_activity_segments`, and `read_activity_stream` endpoints (see the
[design notes](#design-notes-for-original-endpoints) below) were implemented
as registered tools under different names that better reflect their final
scope.

### `find_activities`

Compact, canonical, paginated activity/race discovery by sport, distance, name,
and date. Filters include `sport`/`sports`, `distanceKm` (min/max tuple),
`nameContains`, and `startDate`/`endDate`. Results are sorted by date
(descending by default) with opaque cursor pagination. Race flags are
transparent heuristics, not provider-confirmed race metadata.

### `get_activity_segments`

The required segment/climb path. Performs targeted Strava hydration before
returning persisted effort and segment facts; an empty result must be
interpreted alongside its hydration status. Accepts an `activityId` (logical)
and returns segment efforts, climbs, KOM/PRs, and per-segment analysis.

### `review_activity_deep_dive`

Returns canonical activity identity, source summaries, and structured intervals
for a single `activityId`. Call `read_series` separately only when a specific
sampled metric is required.

### `read_series` (sample-level inspection)

Available through `read_series({ dataset: "activity_samples" })` for
one `activity_source_id`. Inherits the 1,000-point page limit, cursor format,
automatic downsampling, manifest-only Parquet access, and null handling. Returns
no data — not an error — when the source has no registered stream, with a caveat
explaining that sample availability is provider/activity-specific.

### `get_swim_laps`

Source-aware swim lengths when a provider actually supplied them, plus Garmin
detected and Intervals.icu auto-detected sets. A missing length list is
reported as unavailable; laps are never reconstructed from samples.

## Fitness, readiness, and derived-metrics endpoints

- `describe_dataset(dataset)` returns one cataloged schema and its coverage. `training_metric_observations` also reports its observed sports, metric names, units, and source types.
- `get_ftp_history`, `get_vo2max_history`, `power_curve_trend`, and `power_coverage_report` read normalized, source-aware fitness facts. Power tools require an explicit sport or sport family, use `power_bests`/`power_best_facts` for FIT-derived duration values, and do not treat sparse `avg_power` summaries as coverage. `get_vo2max_history` does not default to cycling: omission returns available source labels and requires an explicit choice. For Garmin running VO₂max, request `sport: "running"`; the tool reads the raw `generic` source series and preserves that label on returned observations.
- `readiness_baseline` combines the full running/race performance-indicator set in one call: running lactate threshold (pace/power/HR), VO₂max, race predictions, fitness trend, endurance score, and FIT-derived power bests/coverage as trends. Use this before any single-activity comparison for race-readiness or fitness-target questions.
- `activity_decoupling` derives aerobic decoupling (Pa:Hr for running using speed/HR, Pw:Hr for cycling using power/HR — drift across steady first/second halves) and grade-adjusted pace (GAP, Minetti 2002 cost model) from stored `activity_samples`. Returns null with explanatory caveats when samples are insufficient, walk-heavy, or stop-heavy. Derived values are descriptive only and never overwrite provider-supplied decoupling/GAP. Pass `includeGap: false` to skip GAP computation.
- `find_activities` is implemented for compact, canonical, paginated activity/race discovery by sport, distance, name, and date. Its race flags are transparent heuristics, not provider-confirmed race metadata.
- `get_activity_segments` is the required segment/climb path. It performs the
  targeted Strava hydration before returning the persisted effort and segment
  facts; an empty result must be interpreted alongside its hydration status.
- `latest_cycling_activities` returns Garmin source records to avoid silently double-counting linked Intervals summaries; optional multisport parents are explicitly flagged.
- `cycling_progress_report` composes the preceding read-only outputs with monthly canonical volume/load. It is descriptive, not a physiological model.
- `hydrate_recent_strava_activities` accepts an explicit list or a bounded date/sport window and awaits each write in sequence. Its unmatched output includes the exact Strava search window and safe-match rejection diagnostics.

## Events and race course endpoints

- `resolve_event_course` takes a Garmin/Intervals `eventId` and returns the `courseId` it references plus whether that course geometry has been synced. When geometry is absent the result carries an explicit caveat so a prior course profile is never reused. Optionally pass `pastActivityId` to diff the event course against that activity's course profile.

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

## Agent workflow

For a question like "how did this go in the context of my recent swims?" an
agent should:

1. Use `find_activities` filtered to swimming to identify the selected source
   and comparable source records.
2. Use `review_activity_deep_dive` for the selected activity. Prefer canonical
   Intervals training values only when the logical activity is strongly linked;
   otherwise state the provider used.
3. Use `get_activity_segments` only for set/lap questions. Compute pace using
   the documented formula, name it as derived, and do not call unlabelled
   sections "recovery" as a fact.
4. Use `read_series` with `dataset: "activity_samples"` when the
   summary/segments cannot answer a question about HR evolution, temperature,
   or other sample-level behaviour.
5. For race-readiness questions, call `readiness_baseline` first to establish
   the fitness context before any single-activity comparison.
6. For aerobic decoupling or grade-adjusted pace, call `activity_decoupling`.
7. State missing data and provenance in the answer. Do not imply that an empty
   Garmin split list means no laps occurred — only that detailed split records
   were not returned by the imported endpoint.

## Design notes for original endpoints

The originally proposed `list_recent_activities`, `get_activity_detail`,
`list_activity_segments`, and `read_activity_stream` endpoints were designed
before the registered tools existed. Their semantic intent is preserved in the
implemented tools described above, under different names that reflect their
final scope:

| Proposed name | Implemented as | Notes |
|---|---|---|
| `list_recent_activities` | `find_activities` | Adds sport/distance/name filters, opaque cursor pagination |
| `get_activity_detail` | `review_activity_deep_dive` + `get_activity_segments` | Detail split across review and segment tools |
| `list_activity_segments` | `get_activity_segments` | Includes automatic Strava hydration |
| `read_activity_stream` | `read_series({ dataset: "activity_samples" })` | Source-ID validation added in the handler |

The original input/output contracts (see git history) remain useful as
specifications for acceptance criteria in fixture tests.
