import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { AnalyticsService } from '../src/core/query/analytics.js';
import { getDataset } from '../src/core/query/catalog.js';
import { queryReadOnlyData } from '../src/core/query/sql-guard.js';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { temporaryDatabase } from './helpers.js';

type Db = Awaited<ReturnType<typeof temporaryDatabase>>['database'];

async function seedGarminActivity(db: Db, remoteId: string, occurredOn: string, payload: Record<string, unknown>): Promise<void> {
  const runId = await db.beginRun('garmin', occurredOn);
  await importRecord(db, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId,
    parentRemoteId: null, occurredOn, sourceUpdatedAt: null, rawObjectHash: `raw-${remoteId}`,
    payload: { activityId: remoteId, ...payload }, extension: {},
  });
}

/** Three running activities: flat dynamics keys, a multisport leg nested under
 * summaryDTO (including numeric strings), and one with no dynamics at all. */
async function seededStore(): Promise<Awaited<ReturnType<typeof temporaryDatabase>>['paths']> {
  const setup = await temporaryDatabase();
  await seedGarminActivity(setup.database, 'run-flat', '2026-01-08', {
    startTimeGMT: '2026-01-08T10:00:00', activityType: { typeKey: 'running' }, activityName: 'Flat-key run',
    distance: 12_000, avgVerticalOscillation: 8.1, avgGctTime: 252, avgFlightTime: 112,
    avgStrideLength: 115, avgVerticalRatio: 7.2, averageRunningCadenceInStepsPerMinute: 175,
  });
  await seedGarminActivity(setup.database, 'leg-run-2', '2026-01-09', {
    parentActivityId: 'multi-parent-1',
    summaryDTO: {
      startTimeGMT: '2026-01-09T11:30:00', activityTypeDTO: { typeKey: 'running' }, activityName: 'Multisport leg run',
      distance: 5_000, verticalOscillation: 9.0, avgGroundContactTime: '260', flightTime: 105,
      strideLength: '121.5', verticalRatio: 7.8, averageCadence: 182,
    },
  });
  await seedGarminActivity(setup.database, 'run-plain', '2026-01-10', {
    startTimeGMT: '2026-01-10T09:00:00', activityType: { typeKey: 'running' }, activityName: 'No dynamics run', distance: 8_000,
  });
  await setup.database.close();
  return setup.paths;
}

function isoDay(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

describe('run_dynamics persistence', () => {
  it('normalizes flat and summaryDTO dynamics into run_dynamics_facts', async () => {
    const paths = await seededStore();
    const repository = await openReadOnlyRepository(paths);
    try {
      const rows = await repository.rows<Record<string, unknown>>(
        `SELECT activity_source_id, activity_id, sport, name, vertical_oscillation_cm, ground_contact_time_ms,
           flight_time_ms, stride_length_cm, vertical_ratio_pct, cadence_spm, source_type,
           cast(started_at_utc AT TIME ZONE 'UTC' AS VARCHAR) AS started_at_utc
         FROM run_dynamics ORDER BY activity_source_id`,
      );
      expect(rows).toEqual([
        {
          activity_source_id: 'garmin:leg-run-2', activity_id: 'garmin:leg-run-2', sport: 'running', name: 'Multisport leg run',
          vertical_oscillation_cm: 9, ground_contact_time_ms: 260, flight_time_ms: 105,
          stride_length_cm: 121.5, vertical_ratio_pct: 7.8, cadence_spm: 182,
          source_type: 'provider', started_at_utc: '2026-01-09 11:30:00',
        },
        {
          activity_source_id: 'garmin:run-flat', activity_id: 'garmin:run-flat', sport: 'running', name: 'Flat-key run',
          vertical_oscillation_cm: 8.1, ground_contact_time_ms: 252, flight_time_ms: 112,
          stride_length_cm: 115, vertical_ratio_pct: 7.2, cadence_spm: 175,
          source_type: 'provider', started_at_utc: '2026-01-08 10:00:00',
        },
      ]);

      const absent = await repository.rows<{ count: number }>(
        `SELECT count(*)::INTEGER AS count FROM run_dynamics WHERE activity_source_id = 'garmin:run-plain'`,
      );
      expect(absent[0]?.count).toBe(0);
      const stored = await repository.rows<{ count: number }>(
        `SELECT count(*)::INTEGER AS count FROM run_dynamics_facts`,
      );
      expect(stored[0]?.count).toBe(2);
    } finally {
      await repository.close();
    }
  });

  it('registers the dataset, serves it through analytics, and reports coverage', async () => {
    const paths = await seededStore();
    const dataset = getDataset('run_dynamics');
    expect(dataset.relation).toBe('run_dynamics');
    expect(dataset.dateColumn).toBe('started_at_utc');
    expect(dataset.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['activity_id', 'vertical_oscillation_cm', 'ground_contact_time_ms', 'flight_time_ms', 'stride_length_cm', 'vertical_ratio_pct', 'cadence_spm']),
    );

    const repository = await openReadOnlyRepository(paths);
    try {
      const analytics = new AnalyticsService(repository);
      const mean = await analytics.aggregate({
        dataset: 'run_dynamics',
        metrics: [{ column: 'vertical_oscillation_cm', operation: 'mean', as: 'avg_vertical_oscillation_cm' }],
      });
      expect((mean.data as Array<{ avg_vertical_oscillation_cm: number }>)[0]?.avg_vertical_oscillation_cm).toBeCloseTo(8.55);

      const series = await analytics.readSeries({ dataset: 'run_dynamics', metrics: ['cadence_spm'], resolution: 'raw' });
      expect(series.data).toEqual([
        expect.objectContaining({ cadence_spm: 175 }),
        expect.objectContaining({ cadence_spm: 182 }),
      ]);

      const guarded = await queryReadOnlyData(repository, {
        sql: 'SELECT activity_source_id, vertical_oscillation_cm FROM run_dynamics ORDER BY activity_source_id',
      });
      expect(guarded.data).toEqual([
        { activity_source_id: 'garmin:leg-run-2', vertical_oscillation_cm: 9 },
        { activity_source_id: 'garmin:run-flat', vertical_oscillation_cm: 8.1 },
      ]);
      await expect(queryReadOnlyData(repository, { sql: 'SELECT * FROM run_dynamics_facts' })).rejects.toThrow('not in the read-only catalog');

      const coverage = (await repository.coverage()).coverage as Array<{ dataset: string; start_date: unknown; end_date: unknown; row_count: number }>;
      const byDataset = new Map(coverage.map((entry) => [entry.dataset, entry]));
      const summaryOf = (name: string) => {
        const entry = byDataset.get(name);
        return { row_count: entry?.row_count, start: isoDay(entry?.start_date), end: isoDay(entry?.end_date) };
      };
      expect(summaryOf('activity_summaries')).toEqual({ row_count: 3, start: '2026-01-08', end: '2026-01-10' });
      expect(summaryOf('run_dynamics')).toEqual({ row_count: 2, start: '2026-01-08', end: '2026-01-09' });
      expect(summaryOf('power_bests')).toEqual({ row_count: 0, start: null, end: null });
      expect(summaryOf('swim_lengths')).toEqual({ row_count: 0, start: null, end: null });
      expect(summaryOf('activity_decoupling')).toEqual({ row_count: 0, start: null, end: null });
      expect(summaryOf('segments')).toEqual({ row_count: 0, start: null, end: null });
      expect(summaryOf('course_geometry')).toEqual({ row_count: 0, start: null, end: null });
    } finally {
      await repository.close();
    }
  });

  it('surfaces run_dynamics through the MCP catalog, routing, and tool responses', async () => {
    const paths = await seededStore();
    const server = createCatenceMcpServer(paths);
    const client = new Client({ name: 'run-dynamics-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getInstructions()).toContain('run_dynamics');

      const datasetResult = await client.callTool({ name: 'describe_dataset', arguments: { dataset: 'run_dynamics' } });
      const datasetPayload = JSON.parse(((datasetResult as { content: Array<{ text: string }> }).content[0]).text) as {
        data: { dataset: { name: string; columns: Array<{ name: string }> }; coverage: { row_count: number } | null };
      };
      expect(datasetPayload.data.dataset.name).toBe('run_dynamics');
      expect(datasetPayload.data.dataset.columns.map((column) => column.name)).toContain('vertical_oscillation_cm');
      expect(datasetPayload.data.coverage?.row_count).toBe(2);

      const summariesResult = await client.callTool({ name: 'describe_dataset', arguments: { dataset: 'activity_summaries' } });
      const summariesPayload = JSON.parse(((summariesResult as { content: Array<{ text: string }> }).content[0]).text) as {
        data: { dataset: { columns: Array<{ name: string }> } };
        caveats: string[];
      };
      expect(summariesPayload.data.dataset.columns.map((column) => column.name)).toContain('metrics_json');
      expect(summariesPayload.caveats.join(' ')).toContain('summaryDTO');

      const dataResult = await client.callTool({ name: 'describe_data', arguments: {} });
      const dataPayload = JSON.parse(((dataResult as { content: Array<{ text: string }> }).content[0]).text) as {
        data: { datasets: Array<{ name: string }>; coverage: Array<{ dataset: string }> };
      };
      expect(dataPayload.data.datasets.map((entry) => entry.name)).toContain('run_dynamics');
      expect(dataPayload.data.coverage.map((entry) => entry.dataset)).toEqual(
        expect.arrayContaining(['run_dynamics', 'activity_summaries', 'power_bests', 'swim_lengths', 'activity_decoupling', 'segments', 'course_geometry']),
      );

      const tools = await client.readResource({ uri: 'catence://tools' });
      const toolPayload = JSON.parse((tools.contents[0] as { text: string }).text) as {
        routing: Array<{ question: string; steps: Array<string> }>;
        tools: Array<{ name: string; keywords: Array<string> }>;
      };
      const routing = toolPayload.routing.find((entry) => /running dynamics/i.test(entry.question));
      expect(routing?.steps.join(' ')).toContain('run_dynamics');
      expect(toolPayload.tools.find((tool) => tool.name === 'read_series')?.keywords).toContain('running dynamics');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
