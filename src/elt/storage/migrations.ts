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

export const migrations: Migration[] = [...baseMigrations, stravaAndIdentityMigration];
export type { Migration };
