import { migrations as baseMigrations, type Migration } from './migrations.legacy.js';

const stravaAndIdentityMigration: Migration = {
  version: 6,
  name: 'strava_enrichment_and_activity_links',
  sql: `
    CREATE TABLE IF NOT EXISTS activity_links (
      activity_source_id VARCHAR PRIMARY KEY,
      activity_id VARCHAR NOT NULL,
      method VARCHAR NOT NULL,
      confidence DOUBLE,
      evidence_json JSON NOT NULL DEFAULT '{}',
      linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO activity_links (activity_source_id, activity_id, method, confidence, evidence_json)
    SELECT activity_source_id, activity_id,
      CASE WHEN external_id IS NOT NULL THEN 'strong_external_id' ELSE 'source' END,
      CASE WHEN external_id IS NOT NULL THEN 1.0 ELSE NULL END,
      '{}'
    FROM activity_sources
    ON CONFLICT (activity_source_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS strava_enrichment_state (
      resource_type VARCHAR NOT NULL,
      remote_id VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      continuation_page INTEGER,
      detail_json JSON NOT NULL DEFAULT '{}',
      PRIMARY KEY (resource_type, remote_id)
    );
    CREATE TABLE IF NOT EXISTS strava_rate_state (
      account_id VARCHAR PRIMARY KEY,
      read_limit_15m INTEGER,
      read_usage_15m INTEGER,
      read_limit_day INTEGER,
      read_usage_day INTEGER,
      blocked_until TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS strava_segments (
      segment_id VARCHAR PRIMARY KEY,
      name VARCHAR,
      activity_type VARCHAR,
      distance_m DOUBLE,
      average_grade_pct DOUBLE,
      maximum_grade_pct DOUBLE,
      climb_category INTEGER,
      elevation_high_m DOUBLE,
      elevation_low_m DOUBLE,
      total_elevation_gain_m DOUBLE,
      private BOOLEAN,
      hazardous BOOLEAN,
      starred BOOLEAN,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS activity_segments (
      activity_source_id VARCHAR NOT NULL,
      effort_id VARCHAR NOT NULL,
      segment_id VARCHAR NOT NULL,
      elapsed_s DOUBLE,
      moving_s DOUBLE,
      distance_m DOUBLE,
      average_watts DOUBLE,
      average_hr DOUBLE,
      max_hr DOUBLE,
      average_cadence DOUBLE,
      device_watts BOOLEAN,
      pr_rank INTEGER,
      kom_rank INTEGER,
      started_at TIMESTAMPTZ,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      PRIMARY KEY (activity_source_id, effort_id)
    );
    CREATE INDEX IF NOT EXISTS activity_segments_segment_idx ON activity_segments (segment_id);
    CREATE TABLE IF NOT EXISTS strava_segment_efforts (
      effort_id VARCHAR PRIMARY KEY,
      segment_id VARCHAR NOT NULL,
      strava_activity_id VARCHAR,
      elapsed_s DOUBLE,
      moving_s DOUBLE,
      distance_m DOUBLE,
      average_watts DOUBLE,
      average_hr DOUBLE,
      max_hr DOUBLE,
      average_cadence DOUBLE,
      device_watts BOOLEAN,
      pr_rank INTEGER,
      kom_rank INTEGER,
      started_at TIMESTAMPTZ,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS strava_segment_efforts_segment_idx ON strava_segment_efforts (segment_id, started_at);

    CREATE OR REPLACE VIEW canonical_activity_training AS
    WITH ranked AS (
      SELECT a.*, source.activity_source_id, source.provider, source.remote_activity_id, source.raw_object_hash,
        summary.*, row_number() OVER (
          PARTITION BY a.activity_id
          ORDER BY CASE source.provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END
        ) AS source_rank
      FROM activities a
      JOIN activity_sources source USING (activity_id)
      LEFT JOIN activity_summaries summary USING (activity_source_id)
    ), intervals_analysis AS (
      SELECT source.activity_id,
        max(summary.training_load) AS intervals_training_load,
        max(summary.rpe) AS intervals_rpe,
        max(summary.feel) AS intervals_feel,
        max(summary.weighted_power) AS intervals_weighted_power
      FROM activity_sources source
      JOIN activity_summaries summary USING (activity_source_id)
      WHERE source.provider = 'intervals'
      GROUP BY source.activity_id
    )
    SELECT ranked.* EXCLUDE (source_rank),
      intervals_analysis.intervals_training_load,
      intervals_analysis.intervals_rpe,
      intervals_analysis.intervals_feel,
      intervals_analysis.intervals_weighted_power
    FROM ranked
    LEFT JOIN intervals_analysis USING (activity_id)
    WHERE source_rank = 1;

    CREATE OR REPLACE VIEW segment_effort_history AS
    SELECT effort.*, segment.name AS segment_name, segment.average_grade_pct, segment.climb_category,
      CASE WHEN effort.elapsed_s > 0 AND effort.distance_m IS NOT NULL THEN effort.distance_m / effort.elapsed_s ELSE NULL END AS average_speed_mps,
      segment.raw_object_hash AS segment_raw_object_hash
    FROM strava_segment_efforts effort
    LEFT JOIN strava_segments segment USING (segment_id);
    CREATE OR REPLACE VIEW strava_gear AS
    SELECT provider, remote_id AS gear_id, payload_json, extension_json, raw_object_hash
    FROM domain_entities WHERE provider = 'strava' AND entity_type = 'gear';
  `,
};

const garminPrimaryAndTrainingMetricsMigration: Migration = {
  version: 7,
  name: 'garmin_primary_activity_links_and_training_metric_history',
  sql: `
    CREATE TABLE IF NOT EXISTS training_metric_observations (
      observation_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      sport VARCHAR NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      value_number DOUBLE NOT NULL,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      activity_source_id VARCHAR,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS training_metric_observations_metric_idx
      ON training_metric_observations (provider, metric_name, sport, observed_at);

    -- Intervals preserves the originating Garmin activity ID as external_id.
    -- Attach it to the actual Garmin source so the canonical view selects Garmin
    -- while retaining Intervals' separately named analysis values.
    UPDATE activity_sources AS intervals
    SET activity_id = garmin.activity_id
    FROM activity_sources AS garmin
    WHERE intervals.provider = 'intervals'
      AND garmin.provider = 'garmin'
      AND intervals.external_id = garmin.remote_activity_id
      AND NOT EXISTS (
        SELECT 1 FROM activity_links link
        WHERE link.activity_source_id = intervals.activity_source_id
          AND link.method = 'manual'
      );

    INSERT INTO activity_links (activity_source_id, activity_id, method, confidence, evidence_json)
    SELECT intervals.activity_source_id, garmin.activity_id, 'strong_external_id', 1.0,
      json_object('matchedActivitySourceId', garmin.activity_source_id, 'externalId', intervals.external_id)
    FROM activity_sources AS intervals
    JOIN activity_sources AS garmin
      ON garmin.provider = 'garmin'
      AND intervals.external_id = garmin.remote_activity_id
    WHERE intervals.provider = 'intervals'
    ON CONFLICT (activity_source_id) DO UPDATE SET
      activity_id = CASE WHEN activity_links.method = 'manual' THEN activity_links.activity_id ELSE excluded.activity_id END,
      method = CASE WHEN activity_links.method = 'manual' THEN activity_links.method ELSE excluded.method END,
      confidence = CASE WHEN activity_links.method = 'manual' THEN activity_links.confidence ELSE excluded.confidence END,
      evidence_json = CASE WHEN activity_links.method = 'manual' THEN activity_links.evidence_json ELSE excluded.evidence_json END,
      linked_at = CASE WHEN activity_links.method = 'manual' THEN activity_links.linked_at ELSE now() END;

    DELETE FROM activities AS activity
    WHERE NOT EXISTS (SELECT 1 FROM activity_sources AS source WHERE source.activity_id = activity.activity_id);

    -- Garmin's cycling activity summary retains the FTP active during that
    -- activity. These observations reconstruct history already present in an
    -- imported store without relying on Intervals' derived configuration.
    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:activity:' || source.remote_activity_id,
      'garmin', 'cycling_ftp_w', coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), 'cycling'), activity.started_at_utc,
      try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE),
      'activity_summary', source.remote_activity_id, source.activity_source_id, source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND activity.started_at_utc IS NOT NULL
      AND (lower(coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), '')) LIKE '%cycl%' OR lower(coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), '')) LIKE '%ride%')
      AND try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      sport = excluded.sport,
      raw_object_hash = excluded.raw_object_hash;

    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:source:' || entity.remote_id,
      'garmin', 'cycling_ftp_w', 'cycling',
      cast(json_extract_string(entity.payload_json, '$.calendarDate') AS TIMESTAMPTZ),
      try_cast(json_extract_string(entity.payload_json, '$.functionalThresholdPower') AS DOUBLE),
      'cycling_ftp', entity.remote_id, NULL, entity.raw_object_hash
    FROM source_entities AS entity
    WHERE entity.provider = 'garmin'
      AND entity.entity_type = 'training_metric'
      AND upper(coalesce(json_extract_string(entity.payload_json, '$.sport'), '')) = 'CYCLING'
      AND json_extract_string(entity.payload_json, '$.calendarDate') IS NOT NULL
      AND try_cast(json_extract_string(entity.payload_json, '$.functionalThresholdPower') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      raw_object_hash = excluded.raw_object_hash;
  `,
};

const garminActivitySportAndFtpBackfillMigration: Migration = {
  version: 8,
  name: 'garmin_activity_sport_and_ftp_history_backfill',
  sql: `
    UPDATE activities AS activity
    SET sport = coalesce(
      json_extract_string(summary.metrics_json, '$.activityType.typeKey'),
      json_extract_string(summary.metrics_json, '$.activityTypeDTO.typeKey')
    )
    FROM activity_sources AS source
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND source.activity_id = activity.activity_id
      AND activity.sport IS NULL;

    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:activity:' || source.remote_activity_id,
      'garmin', 'cycling_ftp_w', coalesce(activity.sport, 'cycling'), activity.started_at_utc,
      try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE),
      'activity_summary', source.remote_activity_id, source.activity_source_id, source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND activity.started_at_utc IS NOT NULL
      AND (lower(coalesce(activity.sport, '')) LIKE '%cycl%' OR lower(coalesce(activity.sport, '')) LIKE '%ride%')
      AND try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      sport = excluded.sport,
      raw_object_hash = excluded.raw_object_hash;

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

const garminPrimaryDailyHealthMigration: Migration = {
  version: 9,
  name: 'garmin_primary_daily_health',
  sql: `
    -- Keep all provider observations in daily_metrics. The user-facing health
    -- projection selects one coherent source per date so Garmin does not get
    -- silently mixed with values that Intervals derived from the same device.
    CREATE OR REPLACE VIEW daily_health AS
    WITH provider_health AS (
      SELECT provider, metric_date,
        max(value_number) FILTER (WHERE metric_name = 'resting_hr_bpm') AS resting_hr_bpm,
        max(value_number) FILTER (WHERE metric_name = 'hrv_ms') AS hrv_ms,
        max(value_number) FILTER (WHERE metric_name = 'sleep_seconds') AS sleep_seconds,
        max(value_number) FILTER (WHERE metric_name = 'sleep_score') AS sleep_score,
        max(value_number) FILTER (WHERE metric_name = 'stress') AS stress,
        max(value_number) FILTER (WHERE metric_name = 'body_battery') AS body_battery,
        max(value_number) FILTER (WHERE metric_name = 'readiness') AS readiness,
        max(value_number) FILTER (WHERE metric_name = 'spo2_pct') AS spo2_pct,
        max(value_number) FILTER (WHERE metric_name = 'weight_kg') AS weight_kg,
        max(value_number) FILTER (WHERE metric_name = 'steps') AS steps
      FROM daily_metrics
      GROUP BY provider, metric_date
    ), ranked AS (
      SELECT provider_health.*,
        row_number() OVER (
          PARTITION BY metric_date
          ORDER BY CASE provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, provider
        ) AS source_rank
      FROM provider_health
    )
    SELECT * EXCLUDE (source_rank)
    FROM ranked
    WHERE source_rank = 1;
  `,
};

const garminHistoricalMetricsAndStreamsMigration: Migration = {
  version: 10,
  name: 'garmin_historical_metrics_and_detailed_streams',
  sql: `
    DROP INDEX IF EXISTS training_metric_observations_metric_idx;
    ALTER TABLE training_metric_observations ALTER COLUMN value_number DROP NOT NULL;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS value_text VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS unit VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS device_id VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS dimensions_json JSON;

    CREATE TABLE IF NOT EXISTS wellness_samples (
      sample_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      value_number DOUBLE NOT NULL,
      unit VARCHAR,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS wellness_samples_metric_idx
      ON wellness_samples (provider, metric_name, observed_at);

    CREATE TABLE IF NOT EXISTS health_sessions (
      session_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      session_type VARCHAR NOT NULL,
      occurred_on DATE,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      payload_json JSON NOT NULL,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS health_sessions_date_idx
      ON health_sessions (provider, session_type, occurred_on);

    CREATE TABLE IF NOT EXISTS activity_power_bests (
      provider VARCHAR NOT NULL,
      activity_source_id VARCHAR NOT NULL,
      duration_s INTEGER NOT NULL,
      best_power_w DOUBLE NOT NULL,
      source_type VARCHAR NOT NULL,
      raw_object_hash VARCHAR,
      PRIMARY KEY (provider, activity_source_id, duration_s)
    );
    CREATE OR REPLACE VIEW power_best_facts AS
    SELECT best.*, source.activity_id, activity.started_at_utc, activity.sport
    FROM activity_power_bests AS best
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
  // DuckDB 1.4.4's Node binding can abort when this index rebuild shares the
  // commit transaction with the populated-table ALTERs above. Run it after
  // that durable migration transaction instead; IF NOT EXISTS makes retries
  // safe across subsequent opens.
  postCommitSql: `
    CREATE INDEX IF NOT EXISTS training_metric_observations_metric_idx
      ON training_metric_observations (provider, metric_name, sport, observed_at);
  `,
};

const garminUtcActivityTimestampMigration: Migration = {
  version: 11,
  name: 'garmin_gmt_activity_timestamps_are_utc',
  sql: `
    -- Garmin labels these fields GMT but commonly omits the offset. Without an
    -- explicit Z DuckDB treats them as the host's local time when binding them
    -- to TIMESTAMPTZ, shifting activity matching by the local UTC offset.
    UPDATE activities AS activity
    SET started_at_utc = try_cast(replace(gmt_value, ' ', 'T') || 'Z' AS TIMESTAMPTZ)
    FROM activity_sources AS source
    JOIN source_entities AS entity
      ON entity.provider = source.provider
      AND entity.entity_type = 'activity'
      AND entity.remote_id = source.remote_activity_id
    CROSS JOIN LATERAL (
      SELECT coalesce(
        json_extract_string(entity.payload_json, '$.startTimeGMT'),
        json_extract_string(entity.payload_json, '$.summaryDTO.startTimeGMT')
      ) AS gmt_value
    ) AS timestamp_source
    WHERE source.provider = 'garmin'
      AND source.activity_id = activity.activity_id
      AND gmt_value IS NOT NULL
      AND NOT regexp_matches(gmt_value, '(Z|[+-][0-9]{2}:?[0-9]{2})$');

    UPDATE training_metric_observations AS observation
    SET observed_at = try_cast(replace(gmt_value, ' ', 'T') || 'Z' AS TIMESTAMPTZ)
    FROM source_entities AS entity
    CROSS JOIN LATERAL (
      SELECT coalesce(
        json_extract_string(entity.payload_json, '$.startTimeGMT'),
        json_extract_string(entity.payload_json, '$.summaryDTO.startTimeGMT')
      ) AS gmt_value
    ) AS timestamp_source
    WHERE observation.provider = 'garmin'
      AND observation.source_type = 'activity_summary'
      AND observation.source_remote_id = entity.remote_id
      AND entity.provider = 'garmin'
      AND entity.entity_type = 'activity'
      AND gmt_value IS NOT NULL
      AND NOT regexp_matches(gmt_value, '(Z|[+-][0-9]{2}:?[0-9]{2})$');

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

const garminLactateThresholdMetricsMigration: Migration = {
  version: 12,
  name: 'garmin_lactate_threshold_training_metrics',
  sql: `
    WITH source AS (
      SELECT remote_id, raw_object_hash,
        try_cast(
          CASE WHEN regexp_matches(coalesce(json_extract_string(payload_json, '$.power.calendarDate'), ''), '(Z|[+-][0-9]{2}:?[0-9]{2})$')
            THEN replace(json_extract_string(payload_json, '$.power.calendarDate'), ' ', 'T')
            ELSE replace(json_extract_string(payload_json, '$.power.calendarDate'), ' ', 'T') || 'Z'
          END AS TIMESTAMPTZ
        ) AS power_observed_at,
        try_cast(
          CASE WHEN regexp_matches(coalesce(json_extract_string(payload_json, '$.speed_and_heart_rate.calendarDate'), ''), '(Z|[+-][0-9]{2}:?[0-9]{2})$')
            THEN replace(json_extract_string(payload_json, '$.speed_and_heart_rate.calendarDate'), ' ', 'T')
            ELSE replace(json_extract_string(payload_json, '$.speed_and_heart_rate.calendarDate'), ' ', 'T') || 'Z'
          END AS TIMESTAMPTZ
        ) AS heart_rate_observed_at,
        try_cast(json_extract_string(payload_json, '$.power.functionalThresholdPower') AS DOUBLE) AS running_power_w,
        try_cast(json_extract_string(payload_json, '$.power.powerToWeight') AS DOUBLE) AS running_power_w_kg,
        try_cast(json_extract_string(payload_json, '$.speed_and_heart_rate.speed') AS DOUBLE) AS running_pace_encoding,
        try_cast(json_extract_string(payload_json, '$.speed_and_heart_rate.heartRate') AS DOUBLE) AS running_heart_rate_bpm,
        try_cast(json_extract_string(payload_json, '$.speed_and_heart_rate.heartRateCycling') AS DOUBLE) AS cycling_heart_rate_bpm,
        json_extract_string(payload_json, '$.power.origin') AS origin,
        try_cast(json_extract_string(payload_json, '$.power.isStale') AS BOOLEAN) AS is_stale,
        try_cast(json_extract_string(payload_json, '$.power.weight') AS DOUBLE) AS weight_kg,
        json_extract_string(payload_json, '$.power.ftpCreateTime') AS ftp_create_time,
        json_extract_string(payload_json, '$.power.weightCreateTime') AS weight_create_time
      FROM source_entities
      WHERE provider = 'garmin' AND entity_type = 'lactate_threshold'
    ), observations AS (
      SELECT 'garmin:lactate_threshold:' || remote_id || ':running_power' AS observation_id,
        'running_lactate_threshold_power_w' AS metric_name, 'running' AS sport,
        coalesce(power_observed_at, heart_rate_observed_at) AS observed_at, running_power_w AS value_number,
        'W' AS unit, json_object('origin', origin, 'isStale', is_stale, 'weightKg', weight_kg,
          'powerToWeight', running_power_w_kg, 'ftpCreateTime', ftp_create_time, 'weightCreateTime', weight_create_time) AS dimensions_json,
        remote_id, raw_object_hash
      FROM source
      UNION ALL
      SELECT 'garmin:lactate_threshold:' || remote_id || ':running_power_to_weight',
        'running_lactate_threshold_power_w_kg', 'running', coalesce(power_observed_at, heart_rate_observed_at), running_power_w_kg,
        'W/kg', json_object('origin', origin, 'isStale', is_stale, 'weightKg', weight_kg,
          'powerToWeight', running_power_w_kg, 'ftpCreateTime', ftp_create_time, 'weightCreateTime', weight_create_time),
        remote_id, raw_object_hash
      FROM source
      UNION ALL
      SELECT 'garmin:lactate_threshold:' || remote_id || ':running_pace',
        'running_lactate_threshold_pace_s_per_km', 'running', coalesce(heart_rate_observed_at, power_observed_at), running_pace_encoding * 600,
        's/km', json_object('rawPaceEncoding', running_pace_encoding), remote_id, raw_object_hash
      FROM source
      UNION ALL
      SELECT 'garmin:lactate_threshold:' || remote_id || ':running_heart_rate',
        'running_lactate_threshold_hr_bpm', 'running', coalesce(heart_rate_observed_at, power_observed_at), running_heart_rate_bpm,
        'bpm', json('{}'), remote_id, raw_object_hash
      FROM source
      UNION ALL
      SELECT 'garmin:lactate_threshold:' || remote_id || ':cycling_heart_rate',
        'cycling_lactate_threshold_hr_bpm', 'cycling', coalesce(heart_rate_observed_at, power_observed_at), cycling_heart_rate_bpm,
        'bpm', json('{}'), remote_id, raw_object_hash
      FROM source
    )
    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, value_text, unit, device_id, dimensions_json, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT observation_id, 'garmin', metric_name, sport, observed_at, value_number, NULL, unit, NULL, dimensions_json,
      'lactate_threshold', remote_id, NULL, raw_object_hash
    FROM observations
    WHERE observed_at IS NOT NULL AND value_number IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      sport = excluded.sport, observed_at = excluded.observed_at, value_number = excluded.value_number,
      value_text = excluded.value_text, unit = excluded.unit, device_id = excluded.device_id,
      dimensions_json = excluded.dimensions_json, source_type = excluded.source_type,
      source_remote_id = excluded.source_remote_id, activity_source_id = excluded.activity_source_id,
      raw_object_hash = excluded.raw_object_hash;

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

const swimFactsAndQualityMigration: Migration = {
  version: 13,
  name: 'swim_facts_quality_and_canonical_provenance',
  sql: `
    -- Explicit length records are intentionally separate from generic samples.
    -- A sample stream without a provider-supplied length boundary must never be
    -- expanded into artificial 25 m (or similar) laps.
    CREATE TABLE IF NOT EXISTS swim_lengths (
      activity_source_id VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      length_index INTEGER NOT NULL,
      lap_index INTEGER,
      pool_length_m DOUBLE,
      start_time TIMESTAMPTZ,
      duration_s DOUBLE,
      active_duration_s DOUBLE,
      distance_m DOUBLE,
      stroke_count DOUBLE,
      stroke_rate DOUBLE,
      swolf DOUBLE,
      avg_hr DOUBLE,
      max_hr DOUBLE,
      is_rest BOOLEAN,
      confidence VARCHAR NOT NULL,
      metrics_json JSON NOT NULL DEFAULT '{}',
      raw_object_hash VARCHAR,
      PRIMARY KEY (activity_source_id, source, length_index)
    );
    CREATE INDEX IF NOT EXISTS swim_lengths_source_idx ON swim_lengths (activity_source_id, source, length_index);

    -- Sets preserve the provider's grouping rather than turning a detected
    -- "12 x 52 m" block into a user-authored 12 x 50 m workout.
    CREATE TABLE IF NOT EXISTS swim_sets (
      activity_source_id VARCHAR NOT NULL,
      source_type VARCHAR NOT NULL,
      set_index INTEGER NOT NULL,
      label VARCHAR,
      reps INTEGER,
      rep_distance_m DOUBLE,
      total_distance_m DOUBLE,
      work_s DOUBLE,
      rest_s DOUBLE,
      avg_pace DOUBLE,
      avg_hr DOUBLE,
      max_hr DOUBLE,
      stroke_rate DOUBLE,
      metrics_json JSON NOT NULL DEFAULT '{}',
      raw_object_hash VARCHAR,
      PRIMARY KEY (activity_source_id, source_type, set_index)
    );
    CREATE INDEX IF NOT EXISTS swim_sets_source_idx ON swim_sets (activity_source_id, source_type, set_index);

    CREATE TABLE IF NOT EXISTS activity_quality_flags (
      activity_source_id VARCHAR NOT NULL,
      flag_code VARCHAR NOT NULL,
      severity VARCHAR NOT NULL,
      details_json JSON NOT NULL DEFAULT '{}',
      raw_object_hash VARCHAR,
      PRIMARY KEY (activity_source_id, flag_code)
    );
    CREATE INDEX IF NOT EXISTS activity_quality_flags_source_idx ON activity_quality_flags (activity_source_id, severity);

    ALTER TABLE activity_intervals ADD COLUMN IF NOT EXISTS duration_s DOUBLE;
    ALTER TABLE activity_intervals ADD COLUMN IF NOT EXISTS moving_s DOUBLE;
    ALTER TABLE activity_intervals ADD COLUMN IF NOT EXISTS source_type VARCHAR;
    -- DuckDB binds SELECT intervals.* at view-creation time, so refresh this
    -- projection after extending the underlying interval table.
    CREATE OR REPLACE VIEW activity_interval_facts AS
    SELECT intervals.*, source.activity_id, source.provider,
      activity.started_at_utc, activity.sport, activity.name
    FROM activity_intervals AS intervals
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    -- Older Garmin imports retained the useful split summaries in one raw
    -- payload, then tried to read interval fields from its wrapper object.  A
    -- row per provider summary restores the supplied duration/HR/distance
    -- without manufacturing chronology or per-length splits.
    DELETE FROM activity_intervals AS interval
    USING activity_sources AS source, source_entities AS entity
    WHERE interval.activity_source_id = source.activity_source_id
      AND source.provider = 'garmin'
      AND entity.provider = 'garmin'
      AND entity.entity_type = 'activity_interval'
      AND entity.parent_remote_id = source.remote_activity_id
      AND interval.interval_key = entity.remote_id
      AND json_type(entity.payload_json, '$.splitSummaries') = 'ARRAY';
    -- Some Garmin detail endpoints supplied a wrapper with no interval fields
    -- at all. Those rows are neither a split nor a useful no-distance segment;
    -- remove only that entirely-null legacy shape before adding the supplied
    -- split summaries below.
    DELETE FROM activity_intervals AS interval
    USING activity_sources AS source
    WHERE interval.activity_source_id = source.activity_source_id
      AND source.provider = 'garmin'
      AND interval.source_type IS NULL
      AND interval.start_s IS NULL AND interval.end_s IS NULL AND interval.duration_s IS NULL AND interval.moving_s IS NULL
      AND interval.distance_m IS NULL AND interval.avg_power IS NULL AND interval.avg_hr IS NULL
      AND interval.avg_pace IS NULL AND interval.intensity IS NULL;

    INSERT INTO activity_intervals
      (activity_source_id, interval_key, label, start_s, end_s, distance_m, avg_power, avg_hr, avg_pace, intensity, metrics_json, duration_s, moving_s, source_type)
    SELECT source.activity_source_id,
      'garmin:split_summary:' || entry.key,
      json_extract_string(entry.value, '$.splitType'),
      NULL, NULL,
      try_cast(json_extract_string(entry.value, '$.distance') AS DOUBLE),
      NULL,
      try_cast(json_extract_string(entry.value, '$.averageHR') AS DOUBLE),
      NULL, NULL,
      json_object('splitSummary', entry.value),
      try_cast(json_extract_string(entry.value, '$.duration') AS DOUBLE),
      try_cast(json_extract_string(entry.value, '$.movingDuration') AS DOUBLE),
      'garmin_detected'
    FROM source_entities AS entity
    JOIN activity_sources AS source
      ON source.provider = 'garmin' AND source.remote_activity_id = entity.parent_remote_id
    CROSS JOIN json_each(entity.payload_json, '$.splitSummaries') AS entry
    WHERE entity.provider = 'garmin' AND entity.entity_type = 'activity_interval'
    ON CONFLICT (activity_source_id, interval_key) DO UPDATE SET
      label = excluded.label, start_s = excluded.start_s, end_s = excluded.end_s,
      distance_m = excluded.distance_m, avg_power = excluded.avg_power, avg_hr = excluded.avg_hr,
      avg_pace = excluded.avg_pace, intensity = excluded.intensity, metrics_json = excluded.metrics_json,
      duration_s = excluded.duration_s, moving_s = excluded.moving_s, source_type = excluded.source_type;

    INSERT INTO swim_sets
      (activity_source_id, source_type, set_index, label, reps, rep_distance_m, total_distance_m, work_s, rest_s, avg_pace, avg_hr, max_hr, stroke_rate, metrics_json, raw_object_hash)
    SELECT source.activity_source_id, 'garmin_detected', try_cast(entry.key AS INTEGER),
      json_extract_string(entry.value, '$.splitType'),
      try_cast(json_extract_string(entry.value, '$.noOfSplits') AS INTEGER),
      NULL,
      try_cast(json_extract_string(entry.value, '$.distance') AS DOUBLE),
      try_cast(json_extract_string(entry.value, '$.movingDuration') AS DOUBLE),
      NULL, NULL,
      try_cast(json_extract_string(entry.value, '$.averageHR') AS DOUBLE),
      try_cast(json_extract_string(entry.value, '$.maxHR') AS DOUBLE),
      NULL,
      json_object('splitSummary', entry.value), entity.raw_object_hash
    FROM source_entities AS entity
    JOIN activity_sources AS source
      ON source.provider = 'garmin' AND source.remote_activity_id = entity.parent_remote_id
    CROSS JOIN json_each(entity.payload_json, '$.splitSummaries') AS entry
    WHERE entity.provider = 'garmin' AND entity.entity_type = 'activity_interval'
    ON CONFLICT (activity_source_id, source_type, set_index) DO UPDATE SET
      label = excluded.label, reps = excluded.reps, rep_distance_m = excluded.rep_distance_m,
      total_distance_m = excluded.total_distance_m, work_s = excluded.work_s, rest_s = excluded.rest_s,
      avg_pace = excluded.avg_pace, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
      stroke_rate = excluded.stroke_rate, metrics_json = excluded.metrics_json,
      raw_object_hash = excluded.raw_object_hash;

    -- Intervals.icu exposes its swim blocks on the activity summary.  Parse
    -- only its documented compact labels; duration and pace stay null because
    -- that payload does not supply them reliably.
    WITH blocks AS (
      SELECT source.activity_source_id, source.raw_object_hash, try_cast(entry.key AS INTEGER) AS set_index,
        json_extract_string(entry.value, '$') AS raw_label,
        regexp_extract(json_extract_string(entry.value, '$'), '^\\s*(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*m(?:\\s+(\\d+(?:\\.\\d+)?)\\s*bpm)?\\s*$', 1) AS reps_text,
        regexp_extract(json_extract_string(entry.value, '$'), '^\\s*(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*m(?:\\s+(\\d+(?:\\.\\d+)?)\\s*bpm)?\\s*$', 2) AS distance_text,
        regexp_extract(json_extract_string(entry.value, '$'), '^\\s*(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*m(?:\\s+(\\d+(?:\\.\\d+)?)\\s*bpm)?\\s*$', 3) AS hr_text
      FROM source_entities AS entity
      JOIN activity_sources AS source
        ON source.provider = 'intervals' AND source.remote_activity_id = entity.remote_id
      CROSS JOIN json_each(entity.payload_json, '$.interval_summary') AS entry
      WHERE entity.provider = 'intervals' AND entity.entity_type = 'activity'
    )
    INSERT INTO swim_sets
      (activity_source_id, source_type, set_index, label, reps, rep_distance_m, total_distance_m, work_s, rest_s, avg_pace, avg_hr, max_hr, stroke_rate, metrics_json, raw_object_hash)
    SELECT activity_source_id, 'intervals_auto', set_index, raw_label,
      try_cast(reps_text AS INTEGER), try_cast(distance_text AS DOUBLE),
      try_cast(reps_text AS DOUBLE) * try_cast(distance_text AS DOUBLE),
      NULL, NULL, NULL, try_cast(nullif(hr_text, '') AS DOUBLE), NULL, NULL,
      json_object('rawLabel', raw_label, 'providerGrouping', 'intervals_auto'), raw_object_hash
    FROM blocks
    WHERE reps_text <> '' AND distance_text <> ''
    ON CONFLICT (activity_source_id, source_type, set_index) DO UPDATE SET
      label = excluded.label, reps = excluded.reps, rep_distance_m = excluded.rep_distance_m,
      total_distance_m = excluded.total_distance_m, work_s = excluded.work_s, rest_s = excluded.rest_s,
      avg_pace = excluded.avg_pace, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
      stroke_rate = excluded.stroke_rate, metrics_json = excluded.metrics_json,
      raw_object_hash = excluded.raw_object_hash;

    INSERT INTO activity_intervals
      (activity_source_id, interval_key, label, start_s, end_s, distance_m, avg_power, avg_hr, avg_pace, intensity, metrics_json, duration_s, moving_s, source_type)
    SELECT activity_source_id, 'intervals:auto:' || set_index, label,
      NULL, NULL, total_distance_m, NULL, avg_hr, NULL, NULL,
      metrics_json, NULL, NULL, 'intervals_auto'
    FROM swim_sets
    WHERE source_type = 'intervals_auto'
    ON CONFLICT (activity_source_id, interval_key) DO UPDATE SET
      label = excluded.label, start_s = excluded.start_s, end_s = excluded.end_s,
      distance_m = excluded.distance_m, avg_power = excluded.avg_power, avg_hr = excluded.avg_hr,
      avg_pace = excluded.avg_pace, intensity = excluded.intensity, metrics_json = excluded.metrics_json,
      duration_s = excluded.duration_s, moving_s = excluded.moving_s, source_type = excluded.source_type;

    -- Quality flags are source facts.  They make the data limitation visible
    -- without suppressing the original provider summary.
    INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
    SELECT source.activity_source_id, 'pool_length_implausible', 'warning',
      json_object('poolLengthM', CASE WHEN pool_length >= 100 THEN pool_length / 100 ELSE pool_length END), source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    CROSS JOIN LATERAL (SELECT try_cast(json_extract_string(summary.metrics_json, '$.poolLength') AS DOUBLE) AS pool_length) AS values
    WHERE source.provider = 'garmin' AND lower(activity.sport) = 'lap_swimming'
      AND pool_length IS NOT NULL
      AND (CASE WHEN pool_length >= 100 THEN pool_length / 100 ELSE pool_length END) NOT BETWEEN 15 AND 100
    ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash;

    INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
    SELECT source.activity_source_id, 'zero_swim_speed_and_cadence', 'warning',
      json_object('averageSpeedMps', average_speed, 'strokeCadenceSpm', cadence, 'durationS', greatest(coalesce(summary.moving_s, 0), coalesce(summary.elapsed_s, 0))), source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    CROSS JOIN LATERAL (
      SELECT try_cast(json_extract_string(summary.metrics_json, '$.averageSpeed') AS DOUBLE) AS average_speed,
        try_cast(json_extract_string(summary.metrics_json, '$.averageSwimCadenceInStrokesPerMinute') AS DOUBLE) AS cadence
    ) AS values
    WHERE source.provider = 'garmin' AND lower(activity.sport) = 'lap_swimming'
      AND greatest(coalesce(summary.moving_s, 0), coalesce(summary.elapsed_s, 0)) >= 900
      AND average_speed = 0 AND cadence = 0
    ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash;

    INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
    SELECT source.activity_source_id, 'active_lengths_distance_mismatch', 'warning',
      json_object('activeLengths', active_lengths, 'poolLengthM', pool_length_m, 'expectedDistanceM', active_lengths * pool_length_m, 'summaryDistanceM', summary.distance_m), source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    CROSS JOIN LATERAL (
      SELECT try_cast(json_extract_string(summary.metrics_json, '$.activeLengths') AS DOUBLE) AS active_lengths,
        try_cast(json_extract_string(summary.metrics_json, '$.poolLength') AS DOUBLE) AS raw_pool_length
    ) AS raw_values
    CROSS JOIN LATERAL (SELECT CASE WHEN raw_pool_length >= 100 THEN raw_pool_length / 100 ELSE raw_pool_length END AS pool_length_m) AS values
    WHERE source.provider = 'garmin' AND lower(activity.sport) = 'lap_swimming'
      AND active_lengths > 0 AND pool_length_m > 0 AND summary.distance_m > 0
      AND abs(active_lengths * pool_length_m - summary.distance_m) > greatest(pool_length_m, active_lengths * pool_length_m * 0.02)
    ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash;

    INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
    SELECT source.activity_source_id, 'swim_length_data_unavailable', 'info',
      json_object('reason', 'No explicit provider-supplied per-length records were imported.'), source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    WHERE source.provider = 'garmin' AND lower(activity.sport) = 'lap_swimming'
      AND NOT EXISTS (SELECT 1 FROM swim_lengths AS length WHERE length.activity_source_id = source.activity_source_id)
    ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash;

    WITH comparisons AS (
      SELECT activity_id,
        max(activity_source_id) FILTER (WHERE provider = 'garmin') AS garmin_source_id,
        max(distance_m) FILTER (WHERE provider = 'garmin') AS garmin_distance_m,
        max(activity_source_id) FILTER (WHERE provider = 'intervals') AS intervals_source_id,
        max(distance_m) FILTER (WHERE provider = 'intervals') AS intervals_distance_m
      FROM activity_summary_facts
      GROUP BY activity_id
    )
    INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
    SELECT source.activity_source_id, 'provider_distance_disagreement', 'warning',
      json_object('garminDistanceM', comparison.garmin_distance_m, 'intervalsDistanceM', comparison.intervals_distance_m,
        'differenceM', abs(comparison.garmin_distance_m - comparison.intervals_distance_m), 'toleranceM', greatest(50, comparison.garmin_distance_m * 0.05)),
      source.raw_object_hash
    FROM comparisons AS comparison
    JOIN activity_sources AS source ON source.activity_id = comparison.activity_id AND source.provider IN ('garmin', 'intervals')
    WHERE comparison.garmin_distance_m IS NOT NULL AND comparison.intervals_distance_m IS NOT NULL
      AND abs(comparison.garmin_distance_m - comparison.intervals_distance_m) > greatest(50, comparison.garmin_distance_m * 0.05)
    ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash;

    CREATE OR REPLACE VIEW swim_length_facts AS
    SELECT length.*, source.activity_id, source.provider, activity.started_at_utc, activity.sport, activity.name
    FROM swim_lengths AS length
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    CREATE OR REPLACE VIEW swim_set_facts AS
    SELECT swim_set.*, source.activity_id, source.provider, activity.started_at_utc, activity.sport, activity.name
    FROM swim_sets AS swim_set
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    CREATE OR REPLACE VIEW activity_quality_flag_facts AS
    SELECT flag.*, source.activity_id, source.provider, activity.started_at_utc, activity.sport, activity.name
    FROM activity_quality_flags AS flag
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    CREATE OR REPLACE VIEW canonical_activity_facts AS
    WITH source_metrics AS (
      SELECT source.activity_id, source.activity_source_id, source.provider,
        summary.distance_m, summary.moving_s, summary.elapsed_s, summary.avg_hr
      FROM activity_sources AS source
      LEFT JOIN activity_summaries AS summary USING (activity_source_id)
    ), per_activity AS (
      SELECT activity_id,
        max(activity_source_id) FILTER (WHERE provider = 'garmin') AS garmin_activity_source_id,
        max(distance_m) FILTER (WHERE provider = 'garmin') AS garmin_distance_m,
        max(moving_s) FILTER (WHERE provider = 'garmin') AS garmin_moving_s,
        max(elapsed_s) FILTER (WHERE provider = 'garmin') AS garmin_elapsed_s,
        max(avg_hr) FILTER (WHERE provider = 'garmin') AS garmin_avg_hr,
        max(activity_source_id) FILTER (WHERE provider = 'intervals') AS intervals_activity_source_id,
        max(distance_m) FILTER (WHERE provider = 'intervals') AS intervals_distance_m,
        max(moving_s) FILTER (WHERE provider = 'intervals') AS intervals_moving_s,
        max(elapsed_s) FILTER (WHERE provider = 'intervals') AS intervals_elapsed_s,
        max(avg_hr) FILTER (WHERE provider = 'intervals') AS intervals_avg_hr
      FROM source_metrics GROUP BY activity_id
    ), flag_rollup AS (
      SELECT source.activity_id,
        json_group_array(json_object('activitySourceId', flag.activity_source_id, 'code', flag.flag_code,
          'severity', flag.severity, 'details', flag.details_json)) AS quality_flags
      FROM activity_quality_flags AS flag
      JOIN activity_sources AS source USING (activity_source_id)
      GROUP BY source.activity_id
    )
    SELECT activity.activity_id, activity.started_at_utc, activity.started_at_local, activity.timezone, activity.sport, activity.name, activity.link_state,
      per_activity.garmin_activity_source_id, per_activity.garmin_distance_m, per_activity.garmin_moving_s, per_activity.garmin_elapsed_s, per_activity.garmin_avg_hr,
      per_activity.intervals_activity_source_id, per_activity.intervals_distance_m, per_activity.intervals_moving_s, per_activity.intervals_elapsed_s, per_activity.intervals_avg_hr,
      coalesce(per_activity.garmin_distance_m, per_activity.intervals_distance_m) AS resolved_distance_m,
      CASE WHEN per_activity.garmin_distance_m IS NOT NULL THEN 'garmin' WHEN per_activity.intervals_distance_m IS NOT NULL THEN 'intervals' ELSE NULL END AS distance_source,
      coalesce(per_activity.garmin_moving_s, per_activity.intervals_moving_s) AS resolved_moving_s,
      CASE WHEN per_activity.garmin_moving_s IS NOT NULL THEN 'garmin' WHEN per_activity.intervals_moving_s IS NOT NULL THEN 'intervals' ELSE NULL END AS moving_s_source,
      coalesce(per_activity.garmin_elapsed_s, per_activity.intervals_elapsed_s) AS resolved_elapsed_s,
      CASE WHEN per_activity.garmin_elapsed_s IS NOT NULL THEN 'garmin' WHEN per_activity.intervals_elapsed_s IS NOT NULL THEN 'intervals' ELSE NULL END AS elapsed_s_source,
      coalesce(per_activity.garmin_avg_hr, per_activity.intervals_avg_hr) AS resolved_avg_hr,
      CASE WHEN per_activity.garmin_avg_hr IS NOT NULL THEN 'garmin' WHEN per_activity.intervals_avg_hr IS NOT NULL THEN 'intervals' ELSE NULL END AS avg_hr_source,
      CASE WHEN per_activity.garmin_distance_m IS NOT NULL AND per_activity.intervals_distance_m IS NOT NULL
        THEN abs(per_activity.garmin_distance_m - per_activity.intervals_distance_m) ELSE NULL END AS provider_distance_difference_m,
      coalesce(flag_rollup.quality_flags, cast('[]' AS JSON)) AS quality_flags
    FROM activities AS activity
    LEFT JOIN per_activity USING (activity_id)
    LEFT JOIN flag_rollup USING (activity_id);

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

const syncRunProgressMigration: Migration = {
  version: 14,
  name: 'sync_run_progress_heartbeats',
  sql: `
    -- Live progress heartbeats for in-flight sync runs. Written by the Node
    -- side from progress records streamed by provider workers; read-only
    -- surfaces (status, progress CLI, MCP) join against sync_runs.
    CREATE TABLE IF NOT EXISTS sync_run_progress (
      run_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      stage VARCHAR NOT NULL,
      current_step VARCHAR,
      completed_units INTEGER NOT NULL DEFAULT 0,
      total_units INTEGER,
      percent DOUBLE NOT NULL DEFAULT 0,
      elapsed_seconds DOUBLE NOT NULL DEFAULT 0,
      estimated_remaining_seconds DOUBLE,
      heartbeat_at TIMESTAMPTZ NOT NULL,
      detail_json JSON NOT NULL DEFAULT '{}'
    );

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

export const migrations: Migration[] = [...baseMigrations, stravaAndIdentityMigration, garminPrimaryAndTrainingMetricsMigration, garminActivitySportAndFtpBackfillMigration, garminPrimaryDailyHealthMigration, garminHistoricalMetricsAndStreamsMigration, garminUtcActivityTimestampMigration, garminLactateThresholdMetricsMigration, swimFactsAndQualityMigration, syncRunProgressMigration];
export type { Migration };
