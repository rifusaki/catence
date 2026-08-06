export type Migration = {
  version: number;
  name: string;
  sql: string;
  /**
   * Idempotent statements that must run after the migration transaction
   * commits. This is reserved for engine operations that cannot safely be
   * combined with a populated-table rewrite on all supported DuckDB builds.
   */
  postCommitSql?: string;
};

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_ingestion_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS source_accounts (
        provider VARCHAR NOT NULL,
        remote_account_id VARCHAR NOT NULL,
        display_name VARCHAR,
        fetched_at TIMESTAMPTZ NOT NULL,
        payload_json JSON NOT NULL,
        PRIMARY KEY (provider, remote_account_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id VARCHAR PRIMARY KEY,
        provider VARCHAR NOT NULL,
        from_date DATE NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        status VARCHAR NOT NULL,
        parser_version INTEGER NOT NULL,
        error_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_items (
        item_id VARCHAR PRIMARY KEY,
        run_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        endpoint VARCHAR NOT NULL,
        remote_id VARCHAR,
        scope_json JSON NOT NULL,
        status VARCHAR NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message VARCHAR,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS raw_objects (
        content_hash VARCHAR PRIMARY KEY,
        provider VARCHAR NOT NULL,
        endpoint VARCHAR NOT NULL,
        remote_id VARCHAR,
        fetched_at TIMESTAMPTZ NOT NULL,
        content_type VARCHAR NOT NULL,
        relative_path VARCHAR NOT NULL,
        scope_json JSON NOT NULL,
        parser_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_entities (
        provider VARCHAR NOT NULL,
        entity_type VARCHAR NOT NULL,
        remote_id VARCHAR NOT NULL,
        parent_remote_id VARCHAR,
        occurred_on DATE,
        source_updated_at TIMESTAMPTZ,
        raw_object_hash VARCHAR,
        payload_json JSON NOT NULL,
        extension_json JSON NOT NULL,
        normalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, entity_type, remote_id)
      );
      CREATE TABLE IF NOT EXISTS normalization_errors (
        error_id VARCHAR PRIMARY KEY,
        run_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        endpoint VARCHAR NOT NULL,
        remote_id VARCHAR,
        message VARCHAR NOT NULL,
        retryable BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS activities (
        activity_id VARCHAR PRIMARY KEY,
        started_at_utc TIMESTAMPTZ,
        started_at_local VARCHAR,
        timezone VARCHAR,
        sport VARCHAR,
        name VARCHAR,
        link_state VARCHAR NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_sources (
        activity_source_id VARCHAR PRIMARY KEY,
        activity_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        remote_activity_id VARCHAR NOT NULL,
        external_id VARCHAR,
        raw_object_hash VARCHAR,
        UNIQUE (provider, remote_activity_id)
      );
      CREATE TABLE IF NOT EXISTS activity_summaries (
        activity_source_id VARCHAR PRIMARY KEY,
        distance_m DOUBLE,
        moving_s DOUBLE,
        elapsed_s DOUBLE,
        elevation_gain_m DOUBLE,
        calories DOUBLE,
        avg_hr DOUBLE,
        max_hr DOUBLE,
        avg_power DOUBLE,
        weighted_power DOUBLE,
        avg_cadence DOUBLE,
        training_load DOUBLE,
        rpe DOUBLE,
        feel DOUBLE,
        metrics_json JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_intervals (
        activity_source_id VARCHAR NOT NULL,
        interval_key VARCHAR NOT NULL,
        label VARCHAR,
        start_s DOUBLE,
        end_s DOUBLE,
        distance_m DOUBLE,
        avg_power DOUBLE,
        avg_hr DOUBLE,
        avg_pace DOUBLE,
        intensity DOUBLE,
        metrics_json JSON NOT NULL,
        PRIMARY KEY (activity_source_id, interval_key)
      );
      CREATE TABLE IF NOT EXISTS daily_metrics (
        provider VARCHAR NOT NULL,
        metric_date DATE NOT NULL,
        metric_name VARCHAR NOT NULL,
        value_number DOUBLE,
        value_text VARCHAR,
        unit VARCHAR,
        raw_object_hash VARCHAR,
        PRIMARY KEY (provider, metric_date, metric_name)
      );
      CREATE TABLE IF NOT EXISTS nutrition_days (
        provider VARCHAR NOT NULL,
        nutrition_date DATE NOT NULL,
        energy_kcal DOUBLE,
        carbohydrates_g DOUBLE,
        protein_g DOUBLE,
        fat_g DOUBLE,
        hydration_ml DOUBLE,
        metrics_json JSON NOT NULL,
        raw_object_hash VARCHAR,
        PRIMARY KEY (provider, nutrition_date)
      );
      CREATE TABLE IF NOT EXISTS nutrition_items (
        provider VARCHAR NOT NULL,
        remote_item_id VARCHAR NOT NULL,
        nutrition_date DATE NOT NULL,
        meal VARCHAR,
        consumed_at TIMESTAMPTZ,
        food_name VARCHAR,
        quantity DOUBLE,
        energy_kcal DOUBLE,
        carbohydrates_g DOUBLE,
        protein_g DOUBLE,
        fat_g DOUBLE,
        payload_json JSON NOT NULL,
        raw_object_hash VARCHAR,
        PRIMARY KEY (provider, remote_item_id)
      );
      CREATE TABLE IF NOT EXISTS domain_entities (
        provider VARCHAR NOT NULL,
        entity_type VARCHAR NOT NULL,
        remote_id VARCHAR NOT NULL,
        parent_remote_id VARCHAR,
        occurred_on DATE,
        payload_json JSON NOT NULL,
        extension_json JSON NOT NULL,
        raw_object_hash VARCHAR,
        PRIMARY KEY (provider, entity_type, remote_id)
      );
      CREATE TABLE IF NOT EXISTS stream_manifest (
        provider VARCHAR NOT NULL,
        activity_source_id VARCHAR NOT NULL,
        content_hash VARCHAR NOT NULL,
        relative_path VARCHAR NOT NULL,
        row_count BIGINT NOT NULL,
        start_at TIMESTAMPTZ,
        end_at TIMESTAMPTZ,
        columns_json JSON NOT NULL,
        raw_object_hash VARCHAR,
        PRIMARY KEY (provider, activity_source_id, content_hash)
      );
      CREATE OR REPLACE VIEW daily_health AS
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
      GROUP BY provider, metric_date;
      CREATE OR REPLACE VIEW canonical_activity_training AS
      SELECT * EXCLUDE (priority, row_rank)
      FROM (
        SELECT a.*, s.provider, summary.*, CASE WHEN s.provider = 'intervals' THEN 0 ELSE 1 END AS priority,
          row_number() OVER (PARTITION BY a.activity_id ORDER BY CASE WHEN s.provider = 'intervals' THEN 0 ELSE 1 END) AS row_rank
        FROM activities a
        JOIN activity_sources s USING (activity_id)
        LEFT JOIN activity_summaries summary USING (activity_source_id)
      )
      WHERE row_rank = 1;
    `,
  },
  {
    version: 2,
    name: 'domain_projection_views',
    sql: `
      CREATE OR REPLACE VIEW events AS
      SELECT provider, remote_id AS event_id, occurred_on, parent_remote_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'event';
      CREATE OR REPLACE VIEW workouts AS
      SELECT provider, remote_id AS workout_id, occurred_on, parent_remote_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type IN ('workout', 'scheduled_workout');
      CREATE OR REPLACE VIEW workout_documents AS
      SELECT provider, remote_id AS workout_id, payload_json->'workout_doc' AS workout_doc, payload_json
      FROM domain_entities WHERE entity_type IN ('workout', 'scheduled_workout');
      CREATE OR REPLACE VIEW training_plans AS
      SELECT provider, remote_id AS training_plan_id, occurred_on, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'training_plan';
      CREATE OR REPLACE VIEW routes AS
      SELECT provider, remote_id AS route_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'route';
      CREATE OR REPLACE VIEW gear AS
      SELECT provider, remote_id AS gear_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'gear';
      CREATE OR REPLACE VIEW devices AS
      SELECT provider, remote_id AS device_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'device';
      CREATE OR REPLACE VIEW goals AS
      SELECT provider, remote_id AS goal_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type IN ('goal', 'challenge');
      CREATE OR REPLACE VIEW achievements AS
      SELECT provider, remote_id AS achievement_id, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type IN ('badge', 'personal_record');
      CREATE OR REPLACE VIEW messages AS
      SELECT provider, remote_id AS message_id, parent_remote_id, occurred_on, payload_json, extension_json, raw_object_hash
      FROM domain_entities WHERE entity_type = 'message';
    `,
  },
  {
    version: 3,
    name: 'retrieval_documents',
    sql: `
      CREATE TABLE IF NOT EXISTS retrieval_documents (
        document_id VARCHAR PRIMARY KEY,
        entity_type VARCHAR NOT NULL,
        entity_id VARCHAR NOT NULL,
        activity_source_id VARCHAR,
        provider VARCHAR,
        occurred_on DATE,
        document_text VARCHAR NOT NULL,
        metadata_json JSON NOT NULL,
        content_hash VARCHAR NOT NULL UNIQUE,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS retrieval_documents_entity_idx
        ON retrieval_documents (entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS retrieval_documents_date_idx
        ON retrieval_documents (occurred_on);
      CREATE TABLE IF NOT EXISTS retrieval_index_state (
        index_name VARCHAR PRIMARY KEY,
        status VARCHAR NOT NULL,
        mode VARCHAR NOT NULL,
        source_watermark VARCHAR,
        built_at TIMESTAMPTZ,
        detail_json JSON NOT NULL DEFAULT '{}'
      );
      INSERT INTO retrieval_index_state (index_name, status, mode, detail_json)
      VALUES ('context', 'stale', 'keyword', '{}')
      ON CONFLICT (index_name) DO NOTHING;
    `,
  },
  {
    version: 4,
    name: 'query_projection_views',
    sql: `
      CREATE OR REPLACE VIEW activity_summary_facts AS
      SELECT summary.*, source.activity_id, source.provider, source.remote_activity_id,
        source.raw_object_hash, activity.started_at_utc, activity.started_at_local,
        activity.timezone, activity.sport, activity.name
      FROM activity_summaries summary
      JOIN activity_sources source USING (activity_source_id)
      JOIN activities activity USING (activity_id);
      CREATE OR REPLACE VIEW activity_interval_facts AS
      SELECT intervals.*, source.activity_id, source.provider,
        activity.started_at_utc, activity.sport, activity.name
      FROM activity_intervals intervals
      JOIN activity_sources source USING (activity_source_id)
      JOIN activities activity USING (activity_id);
    `,
  },
  {
    version: 5,
    name: 'incremental_sync_cursors',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_cursors (
        provider VARCHAR NOT NULL,
        cursor_name VARCHAR NOT NULL,
        covered_through_date DATE NOT NULL,
        latest_source_date DATE,
        lookback_days INTEGER NOT NULL,
        last_successful_run_id VARCHAR,
        last_completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status VARCHAR NOT NULL,
        detail_json JSON NOT NULL DEFAULT '{}',
        PRIMARY KEY (provider, cursor_name)
      );
      CREATE TABLE IF NOT EXISTS activity_sync_state (
        provider VARCHAR NOT NULL,
        remote_activity_id VARCHAR NOT NULL,
        summary_hash VARCHAR NOT NULL,
        last_seen_run_id VARCHAR NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_detail_sync_at TIMESTAMPTZ,
        details_status VARCHAR NOT NULL,
        PRIMARY KEY (provider, remote_activity_id)
      );
      CREATE INDEX IF NOT EXISTS activity_sync_state_hash_idx
        ON activity_sync_state (provider, summary_hash);
    `,
  },
];
