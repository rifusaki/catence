import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { writeParquetSamples, type ActivitySample } from '../src/elt/streams.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { buildRetrievalIndex, searchContext } from '../src/core/retrieval/index.js';
import { AnalyticsService } from '../src/core/query/analytics.js';
import { queryReadOnlyData } from '../src/core/query/sql-guard.js';
import { temporaryDatabase } from './helpers.js';

async function fixture() {
  const setup = await temporaryDatabase();
  const runId = await setup.database.beginRun('garmin', '2026-01-01');
  for (let offset = 0; offset < 8; offset++) {
    const date = `2026-01-${String(offset + 1).padStart(2, '0')}`;
    await importRecord(setup.database, runId, {
      kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'daily_health', remoteId: date, parentRemoteId: null, occurredOn: date, sourceUpdatedAt: null, rawObjectHash: null,
      payload: { calendarDate: date, hrvSDNN: 40 + offset * 2, restingHeartRate: 52 - offset, totalSteps: 8_000 + offset * 100 }, extension: {},
    });
  }
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'ride-1', parentRemoteId: null, occurredOn: '2026-01-08', sourceUpdatedAt: null, rawObjectHash: null,
    payload: { id: 'ride-1', start_date: '2026-01-08T10:00:00Z', type: 'Ride', name: 'Tempo ride', distance: 40_000, moving_time: 6_000, icu_training_load: 85, average_heartrate: 145 }, extension: {},
  });
  const samples: ActivitySample[] = Array.from({ length: 1_001 }, (_, index) => ({
    activity_source_id: 'intervals:ride-1', timestamp_utc: new Date(Date.parse('2026-01-08T10:00:00Z') + index * 1_000).toISOString(), elapsed_s: index, distance_m: index * 10,
    latitude: null, longitude: null, altitude_m: null, heart_rate_bpm: 130 + (index % 10), power_w: 180 + (index % 40), cadence_rpm: null, speed_mps: null, temperature_c: null, grade_pct: null, extras_json: '{}',
  }));
  const stream = await writeParquetSamples(setup.database, setup.paths, 'intervals', 'ride-1', '2026-01-08', samples);
  await setup.database.run(`INSERT INTO stream_manifest VALUES ('intervals', 'intervals:ride-1', $hash, $path, $rowCount, $startAt, $endAt, $columns, NULL)`, {
    hash: stream.contentHash, path: stream.relativePath, rowCount: samples.length, startAt: samples[0]?.timestamp_utc ?? null, endAt: samples.at(-1)?.timestamp_utc ?? null, columns: JSON.stringify(stream.columns),
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'nutrition_log', remoteId: 'nutrition-1', parentRemoteId: null, occurredOn: '2026-01-08', sourceUpdatedAt: null, rawObjectHash: null,
    payload: { calendarDate: '2026-01-08', totalCalories: 2_700, totalCarbs: 350, totalProtein: 130, foodItems: [{ id: 'oats', foodName: 'Oats with banana', meal: 'breakfast', calories: 500, carbs: 90, protein: 18 }] }, extension: {},
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'event', remoteId: 'event-1', parentRemoteId: null, occurredOn: '2026-01-09', sourceUpdatedAt: null, rawObjectHash: null,
    payload: { title: 'Long ride plan', description: 'Endurance ride with intervals.' }, extension: {},
  });
  await setup.database.finishRun(runId);
  await buildRetrievalIndex(setup.database);
  await setup.database.close();
  return setup.paths;
}

describe('read-only retrieval and analytics', () => {
  it('supports HRV evolution, fitting, guarded SQL, and retrieval context', async () => {
    const paths = await fixture();
    const repository = await openReadOnlyRepository(paths);
    try {
      const analytics = new AnalyticsService(repository);
      const series = await analytics.readSeries({ dataset: 'daily_health', metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', resolution: 'day' });
      expect(series.data).toHaveLength(8);
      const trend = await analytics.analyzeSeries({ dataset: 'daily_health', metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', resolution: 'day', analysis: 'linear_trend' });
      expect((trend.data as { slope: number }).slope).toBeCloseTo(2);
      const model = await analytics.fitSeriesModel({ dataset: 'daily_health', metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', resolution: 'day', model: 'ols_linear' });
      expect((model.data as { rSquared: number }).rSquared).toBeCloseTo(1);
      const aggregate = await analytics.aggregate({ dataset: 'nutrition_days', metrics: [{ column: 'carbohydrates_g', operation: 'sum', as: 'carbs' }] });
      expect((aggregate.data as Array<{ carbs: number }>)[0]?.carbs).toBe(350);
      const downsampled = await analytics.readSeries({ dataset: 'activity_samples', metrics: ['power_w'], filters: [{ column: 'activity_source_id', op: 'eq', value: 'intervals:ride-1' }], resolution: 'auto' });
      expect((downsampled.query as { resolution: string }).resolution).toBe('1m');
      expect(downsampled.data).toHaveLength(17);
      const sql = await queryReadOnlyData(repository, { sql: 'SELECT metric_date, hrv_ms FROM daily_health ORDER BY metric_date' });
      expect(sql.data).toHaveLength(8);
      await expect(queryReadOnlyData(repository, { sql: 'DELETE FROM daily_health' })).rejects.toThrow('Only a single SELECT');
      const context = await searchContext(repository, { query: 'oats banana' });
      expect(context.data).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: 'nutrition_item', recommendedFollowUpTool: 'aggregate_data' })]));
    } finally {
      await repository.close();
    }
  });

  it('rejects cursor tampering and source paths', async () => {
    const paths = await fixture();
    const repository = await openReadOnlyRepository(paths);
    try {
      const analytics = new AnalyticsService(repository);
      await expect(analytics.readSeries({ dataset: 'daily_health', metrics: ['hrv_ms'], cursor: 'tampered' })).rejects.toThrow('Invalid or mismatched cursor');
      await expect(queryReadOnlyData(repository, { sql: "SELECT * FROM read_parquet('/tmp/anything.parquet')" })).rejects.toThrow('prohibited');
    } finally {
      await repository.close();
    }
  });

  it('serves the catalog and analytical tools through MCP transport', async () => {
    const paths = await fixture();
    const server = createCatenceMcpServer(paths);
    const client = new Client({ name: 'catence-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['catence_status', 'read_series', 'query_read_only_data', 'search_context']));
      const result = await client.callTool({ name: 'read_series', arguments: { dataset: 'daily_health', metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', resolution: 'day' } });
      const payload = JSON.parse(((result as { content: Array<{ text: string }> }).content[0]).text) as { data: unknown[] };
      expect(payload.data).toHaveLength(8);
      const resource = await client.readResource({ uri: 'catence://summary/2026-01-01/2026-01-08' });
      expect(resource.contents[0]?.mimeType).toBe('application/json');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
