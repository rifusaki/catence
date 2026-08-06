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
      await connection.run('CREATE TABLE activity_sources (activity_source_id VARCHAR, activity_id VARCHAR, provider VARCHAR, remote_activity_id VARCHAR)');
      await connection.run('CREATE TABLE activities (activity_id VARCHAR, started_at_utc TIMESTAMPTZ, sport VARCHAR)');
      await connection.run('CREATE TABLE source_entities (provider VARCHAR, entity_type VARCHAR, remote_id VARCHAR, payload_json JSON)');
      await connection.run('CREATE TABLE retrieval_index_state (index_name VARCHAR, status VARCHAR)');
      await connection.run("INSERT INTO retrieval_index_state VALUES ('context', 'ready')");
      await connection.run("INSERT INTO activities VALUES ('garmin:g1', '2026-08-04T15:42:59Z', 'swimming')");
      await connection.run("INSERT INTO activity_sources VALUES ('garmin:g1', 'garmin:g1', 'garmin', 'g1')");
      await connection.run("INSERT INTO source_entities VALUES ('garmin', 'activity', 'g1', '{\"startTimeGMT\":\"2026-08-04 10:42:59\"}')");
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const database = await CatenceDatabase.open(paths);
    try {
      expect(await database.rows("SELECT version FROM schema_migrations WHERE version = 11")).toEqual([{ version: 11 }]);
      expect(await database.rows("SELECT value_text, unit, device_id, dimensions_json FROM training_metric_observations WHERE observation_id = 'ftp-1'"))
        .toEqual([{ value_text: null, unit: null, device_id: null, dimensions_json: null }]);
      const indexes = await database.rows<{ index_name: string }>("SELECT index_name FROM duckdb_indexes() WHERE table_name = 'training_metric_observations'");
      expect(indexes.map((index) => index.index_name)).toContain('training_metric_observations_metric_idx');
      expect(await database.rows("SELECT CAST(CAST(epoch(started_at_utc) AS BIGINT) AS VARCHAR) AS epoch_s FROM activities WHERE activity_id = 'garmin:g1'"))
        .toEqual([{ epoch_s: '1785840179' }]);
    } finally {
      await database.close();
    }
  });
});
