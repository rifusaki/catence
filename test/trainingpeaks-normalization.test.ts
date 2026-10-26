import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { temporaryDatabase } from './helpers.js';
import { assertReadOnlyRegistry, trainingpeaksReadRegistry } from '../src/elt/ingestion/providers/registry.js';

describe('TrainingPeaks ingestion', () => {
  it('registers only read-only endpoints', () => {
    expect(() => assertReadOnlyRegistry()).not.toThrow();
    expect(trainingpeaksReadRegistry.map((endpoint) => endpoint.name)).toEqual(['planned_workouts', 'zones', 'athlete_settings']);
    for (const endpoint of trainingpeaksReadRegistry) expect(endpoint.readOnly).toBe(true);
  });

  it('normalizes zone settings into provenance-tagged training metric observations', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('trainingpeaks', '2026-03-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'trainingpeaks', entityType: 'zone_setting', remoteId: '2:power:0',
        parentRemoteId: null, occurredOn: '2026-03-01', sourceUpdatedAt: null, rawObjectHash: 'zone-raw', extension: {},
        payload: { workoutTypeId: 2, threshold: 265, calculationMethod: 'PercentOfThreshold', zones: [{ minimum: 0, maximum: 150 }] },
      });
      const rows = await database.rows<{ provider: string; metric_name: string; sport: string; value_number: number; source_type: string }>(
        "SELECT provider, metric_name, sport, value_number, source_type FROM training_metric_observations WHERE metric_name = 'cycling_ftp_w'",
      );
      expect(rows).toEqual([{ provider: 'trainingpeaks', metric_name: 'cycling_ftp_w', sport: 'cycling', value_number: 265, source_type: 'trainingpeaks_zone_setting' }]);
    } finally {
      await database.close();
    }
  });

  it('never merges TP and Garmin FTP rows for the same metric', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('trainingpeaks', '2026-03-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'trainingpeaks', entityType: 'zone_setting', remoteId: '2:power:0',
        parentRemoteId: null, occurredOn: '2026-03-01', sourceUpdatedAt: null, rawObjectHash: 'zone-raw', extension: {},
        payload: { workoutTypeId: 2, threshold: 265 },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'training_metric', remoteId: '2026-03-01T09:00:00.0',
        parentRemoteId: null, occurredOn: '2026-03-01', sourceUpdatedAt: null, rawObjectHash: 'garmin-raw', extension: {},
        payload: { sport: 'CYCLING', calendarDate: '2026-03-01T09:00:00.0', functionalThresholdPower: 258 },
      });
      const rows = await database.rows<{ provider: string; value_number: number }>(
        "SELECT provider, value_number FROM training_metric_observations WHERE metric_name = 'cycling_ftp_w' ORDER BY provider",
      );
      expect(rows).toEqual([
        { provider: 'garmin', value_number: 258 },
        { provider: 'trainingpeaks', value_number: 265 },
      ]);
    } finally {
      await database.close();
    }
  });

  it('upserts zone settings idempotently by stable key', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('trainingpeaks', '2026-03-01');
    try {
      const record = {
        kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'trainingpeaks' as const,
        entityType: 'zone_setting', remoteId: '2:power:0', parentRemoteId: null, occurredOn: '2026-03-01',
        sourceUpdatedAt: null, rawObjectHash: 'zone-raw', extension: {}, payload: { workoutTypeId: 2, threshold: 265 },
      };
      await importRecord(database, runId, record);
      await importRecord(database, runId, { ...record, payload: { workoutTypeId: 2, threshold: 270 } });
      const rows = await database.rows<{ value_number: number }>(
        "SELECT value_number FROM training_metric_observations WHERE metric_name = 'cycling_ftp_w'",
      );
      expect(rows).toEqual([{ value_number: 270 }]);
    } finally {
      await database.close();
    }
  });

  it('stores planned workouts as domain entities with trainingpeaks provenance', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('trainingpeaks', '2026-03-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'trainingpeaks', entityType: 'planned_workout', remoteId: '101',
        parentRemoteId: null, occurredOn: '2026-03-02', sourceUpdatedAt: null, rawObjectHash: 'workout-raw', extension: {},
        payload: { workoutId: 101, workoutDay: '2026-03-02', title: 'Threshold 4x8', sport: 'Bike', tssPlanned: 85, structure: { blocks: [{ type: 'Warmup' }] } },
      });
      const rows = await database.rows<{ provider: string; payload_json: { title?: string } }>(
        "SELECT provider, payload_json FROM domain_entities WHERE entity_type = 'planned_workout' AND remote_id = '101'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.provider).toBe('trainingpeaks');
      const payload = typeof rows[0]?.payload_json === 'string' ? JSON.parse(String(rows[0]?.payload_json)) : rows[0]?.payload_json;
      expect((payload as { title?: string }).title).toBe('Threshold 4x8');
    } finally {
      await database.close();
    }
  });
});
