import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { ensurePaths, resolvePaths } from '../../src/core/runtime/configuration.js';
import { CatenceDatabase } from '../../src/elt/storage/database.js';

describe('post-commit migrations', () => {
  it('migrates a populated v9 training-metrics table before rebuilding its index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-v9-migration-'));
    const paths = resolvePaths(root);
    await ensurePaths(paths);
    const instance = await DuckDBInstance.create(paths.database);
    const connection = await instance.connect();
    try {
      await connection.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      await connection.run("INSERT INTO schema_migrations (version, name) SELECT version, 'fixture' FROM generate_series(1, 9) AS value(version)");
      await connection.run(`
        CREATE TABLE training_metric_observations (
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
        )
      `);
      await connection.run("INSERT INTO training_metric_observations VALUES ('ftp-1', 'garmin', 'cycling_ftp_w', 'cycling', now(), 250, 'fixture', 'ftp-1', NULL, NULL)");
      await connection.run('CREATE INDEX training_metric_observations_metric_idx ON training_metric_observations (provider, metric_name, sport, observed_at)');
      await connection.run('CREATE TABLE activity_sources (activity_source_id VARCHAR, activity_id VARCHAR, provider VARCHAR, remote_activity_id VARCHAR, external_id VARCHAR, raw_object_hash VARCHAR)');
      await connection.run('CREATE TABLE activities (activity_id VARCHAR, started_at_utc TIMESTAMPTZ, started_at_local VARCHAR, timezone VARCHAR, sport VARCHAR, name VARCHAR, link_state VARCHAR)');
      await connection.run('CREATE TABLE activity_summaries (activity_source_id VARCHAR, distance_m DOUBLE, moving_s DOUBLE, elapsed_s DOUBLE, avg_hr DOUBLE, metrics_json JSON)');
      await connection.run('CREATE TABLE activity_intervals (activity_source_id VARCHAR, interval_key VARCHAR, label VARCHAR, start_s DOUBLE, end_s DOUBLE, distance_m DOUBLE, avg_power DOUBLE, avg_hr DOUBLE, avg_pace DOUBLE, intensity DOUBLE, metrics_json JSON, PRIMARY KEY (activity_source_id, interval_key))');
      await connection.run('CREATE TABLE source_entities (provider VARCHAR, entity_type VARCHAR, remote_id VARCHAR, parent_remote_id VARCHAR, payload_json JSON, raw_object_hash VARCHAR)');
      await connection.run('CREATE TABLE retrieval_index_state (index_name VARCHAR, status VARCHAR)');
      await connection.run("INSERT INTO retrieval_index_state VALUES ('context', 'ready')");
      await connection.run("INSERT INTO activities VALUES ('garmin:g1', '2026-08-04T15:42:59Z', NULL, NULL, 'swimming', NULL, 'unlinked')");
      await connection.run("INSERT INTO activity_sources VALUES ('garmin:g1', 'garmin:g1', 'garmin', 'g1', NULL, NULL)");
      await connection.run("INSERT INTO source_entities VALUES ('garmin', 'activity', 'g1', NULL, '{\"startTimeGMT\":\"2026-08-04 10:42:59\"}', NULL)");
      await connection.run("INSERT INTO source_entities VALUES ('garmin', 'lactate_threshold', 'latest', NULL, '{\"speed_and_heart_rate\":{\"calendarDate\":\"2026-08-04T10:42:59\",\"speed\":0.42,\"heartRate\":178},\"power\":{\"calendarDate\":\"2026-08-04T10:42:59\",\"functionalThresholdPower\":295,\"powerToWeight\":5.7}}', 'threshold-raw')");
      await connection.run(`CREATE VIEW activity_summary_facts AS
        SELECT summary.*, source.activity_id, source.provider, source.remote_activity_id, source.raw_object_hash,
          activity.started_at_utc, activity.started_at_local, activity.timezone, activity.sport, activity.name
        FROM activity_summaries AS summary
        JOIN activity_sources AS source USING (activity_source_id)
        JOIN activities AS activity USING (activity_id)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const database = await CatenceDatabase.open(paths);
    try {
      expect(await database.rows("SELECT version FROM schema_migrations WHERE version = 13")).toEqual([{ version: 13 }]);
      expect(await database.rows("SELECT value_text, unit, device_id, dimensions_json FROM training_metric_observations WHERE observation_id = 'ftp-1'"))
        .toEqual([{ value_text: null, unit: null, device_id: null, dimensions_json: null }]);
      const indexes = await database.rows<{ index_name: string }>("SELECT index_name FROM duckdb_indexes() WHERE table_name = 'training_metric_observations'");
      expect(indexes.map((index) => index.index_name)).toContain('training_metric_observations_metric_idx');
      expect(await database.rows("SELECT CAST(CAST(epoch(started_at_utc) AS BIGINT) AS VARCHAR) AS epoch_s FROM activities WHERE activity_id = 'garmin:g1'"))
        .toEqual([{ epoch_s: '1785840179' }]);
      expect(await database.rows("SELECT metric_name, value_number, raw_object_hash FROM training_metric_observations WHERE source_type = 'lactate_threshold' ORDER BY metric_name"))
        .toEqual([
          { metric_name: 'running_lactate_threshold_hr_bpm', value_number: 178, raw_object_hash: 'threshold-raw' },
          { metric_name: 'running_lactate_threshold_pace_s_per_km', value_number: 252, raw_object_hash: 'threshold-raw' },
          { metric_name: 'running_lactate_threshold_power_w', value_number: 295, raw_object_hash: 'threshold-raw' },
          { metric_name: 'running_lactate_threshold_power_w_kg', value_number: 5.7, raw_object_hash: 'threshold-raw' },
        ]);
    } finally {
      await database.close();
    }
  });
});
