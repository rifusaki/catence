import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { writeParquetSamples, type ActivitySample } from '../src/elt/streams.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { buildRetrievalIndex, searchContext } from '../src/core/retrieval/index.js';
import { AnalyticsService } from '../src/core/query/analytics.js';
import { ActivityDiscoveryService } from '../src/core/query/activity-discovery.js';
import { FitnessService } from '../src/core/query/fitness.js';
import { WellnessService } from '../src/core/query/wellness.js';
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
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'garmin-ride-1', parentRemoteId: null, occurredOn: '2026-01-07', sourceUpdatedAt: null, rawObjectHash: 'garmin-raw',
    payload: { activityId: 'garmin-ride-1', startTimeGMT: '2026-01-07T10:00:00Z', activityType: 'road_biking', activityName: 'Road ride', distance: 42_000, duration: 6_300, maxFtp: 250 }, extension: {},
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'strava', entityType: 'activity', remoteId: 'strava-ride-1', parentRemoteId: null, occurredOn: '2026-01-07', sourceUpdatedAt: null, rawObjectHash: 'strava-raw',
    payload: {
      id: 'strava-ride-1', start_date: '2026-01-07T10:00:00Z', start_date_local: '2026-01-07T05:00:00', type: 'Ride', name: 'Road ride', distance: 42_000, moving_time: 6_300,
      segment_efforts: [{ id: 'strava-effort-1', elapsed_time: 600, moving_time: 590, distance: 3_500, average_watts: 280, average_heartrate: 160, pr_rank: 2, segment: { id: 'segment-1', name: 'Test climb', distance: 3_500, average_grade: 5.5, maximum_grade: 10.2, climb_category: 2 } }],
    }, extension: {},
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'garmin-run-1', parentRemoteId: null, occurredOn: '2026-01-06', sourceUpdatedAt: null, rawObjectHash: 'garmin-run-raw',
    payload: { activityId: 'garmin-run-1', startTimeGMT: '2026-01-06T10:00:00Z', activityType: { typeKey: 'trail_running' }, activityName: 'Trail run', distance: 15_000, duration: 5_400 }, extension: {},
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'functional_threshold_power', remoteId: 'cycling:2026-01-08', parentRemoteId: null, occurredOn: '2026-01-08', sourceUpdatedAt: null, rawObjectHash: 'ftp-raw',
    payload: { sport: 'CYCLING', calendarDate: '2026-01-08', functionalThresholdPower: 255 }, extension: {},
  });
  await importRecord(setup.database, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'max_metric', remoteId: 'max-1', parentRemoteId: null, occurredOn: '2026-01-08', sourceUpdatedAt: null, rawObjectHash: 'max-raw',
    payload: { generic: { calendarDate: '2026-01-08', vo2MaxPreciseValue: 58.5 }, cycling: { calendarDate: '2026-01-08', vo2MaxPreciseValue: 55.2 } }, extension: {},
  });
  for (const [durationSeconds, bestPowerWatts] of [[5, 600], [300, 280], [1_200, 240]] as const) {
    await importRecord(setup.database, runId, {
      kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_power_best', remoteId: `power-${durationSeconds}`, parentRemoteId: 'garmin-ride-1', occurredOn: '2026-01-07', sourceUpdatedAt: null, rawObjectHash: `power-${durationSeconds}`,
      payload: { durationSeconds, bestPowerWatts }, extension: {},
    });
  }
  for (const [durationSeconds, bestPowerWatts] of [[5, 390], [300, 270]] as const) {
    await importRecord(setup.database, runId, {
      kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_power_best', remoteId: `run-power-${durationSeconds}`, parentRemoteId: 'garmin-run-1', occurredOn: '2026-01-06', sourceUpdatedAt: null, rawObjectHash: `run-power-${durationSeconds}`,
      payload: { durationSeconds, bestPowerWatts, sourceType: 'garmin_fit_derived' }, extension: {},
    });
  }
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
      const temporalAggregate = await analytics.aggregate({ dataset: 'training_metrics', dimensions: ['metric_name'], metrics: [{ column: 'observed_at', operation: 'min', as: 'first_observed' }, { column: 'observed_at', operation: 'max', as: 'last_observed' }] });
      expect(temporalAggregate.data).toEqual(expect.arrayContaining([expect.objectContaining({ metric_name: 'cycling_ftp_w' })]));
      const downsampled = await analytics.readSeries({ dataset: 'activity_samples', metrics: ['power_w'], filters: [{ column: 'activity_source_id', op: 'eq', value: 'intervals:ride-1' }], resolution: 'auto' });
      expect((downsampled.query as { resolution: string }).resolution).toBe('1m');
      expect(downsampled.data).toHaveLength(17);
      const sql = await queryReadOnlyData(repository, { sql: 'SELECT metric_date, hrv_ms FROM daily_health ORDER BY metric_date', pageSize: 2 });
      expect(sql.data).toHaveLength(2);
      expect(sql).toEqual(expect.objectContaining({ returnedRows: 2, totalRows: 8, truncated: true, nextCursor: expect.any(String) }));
      const sqlPageTwo = await queryReadOnlyData(repository, { sql: 'SELECT metric_date, hrv_ms FROM daily_health ORDER BY metric_date', pageSize: 2, cursor: sql.nextCursor as string });
      expect((sqlPageTwo.data as Array<{ metric_date: string }>)[0]?.metric_date).toContain('2026-01-03');
      const aliasedSql = await queryReadOnlyData(repository, { sql: 'SELECT a.activity_id, source.activity_source_id FROM activities AS a JOIN activity_sources AS source ON a.activity_id = source.activity_id ORDER BY source.activity_source_id' });
      expect(aliasedSql.data).toEqual(expect.arrayContaining([expect.objectContaining({ activity_source_id: 'garmin:garmin-ride-1' })]));
      const fitness = new FitnessService(repository);
      const wellness = new WellnessService(repository);
      const wellnessCorrelation = await wellness.correlate({ metricA: 'hrv_ms', metricB: 'resting_hr_bpm', startDate: '2026-01-01', endDate: '2026-01-08', scanLags: true });
      expect((wellnessCorrelation.data as { selected: { correlation: number | null } }).selected.correlation).toBeLessThan(0);
      const wellnessBaselines = await wellness.baselines({ metrics: ['hrv_ms', 'resting_hr_bpm'], endDate: '2026-01-08', windowDays: 8 });
      expect((wellnessBaselines.data as Array<{ metric: string; latestValue: number | null }>)).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'hrv_ms', latestValue: 54 })]));
      const wellnessAnomalies = await wellness.anomalies({ metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', zThreshold: 1 });
      expect((wellnessAnomalies.data as { metrics: Array<{ anomalies: unknown[] }> }).metrics[0]?.anomalies.length).toBeGreaterThan(0);
      const wellnessCoverage = await wellness.coverage({ metrics: ['hrv_ms', 'training_load'], startDate: '2026-01-01', endDate: '2026-01-08' });
      expect((wellnessCoverage.data as { metrics: Array<{ metric: string; expectedDays: number }> }).metrics).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'hrv_ms', expectedDays: 8 })]));
      expect((await fitness.ftpHistory()).data).toEqual(expect.objectContaining({ preferredSeries: expect.arrayContaining([expect.objectContaining({ value_number: 255 })]) }));
      expect(await fitness.vo2MaxHistory()).toEqual(expect.objectContaining({ data: expect.objectContaining({
        availableSports: expect.arrayContaining([expect.objectContaining({ sport: 'cycling', latest: 55.2 })]),
        sportAliases: [expect.objectContaining({ requestedSport: 'running', sourceSport: 'generic' })],
        actionRequired: 'Choose a sport explicitly. Use running for Garmin running VO₂max.',
      }) }));
      expect(await fitness.vo2MaxHistory({ sport: 'cycling' })).toEqual(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ value_number: 55.2 })]) }));
      expect(await fitness.vo2MaxHistory({ sport: 'generic' })).toEqual(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ value_number: 58.5 })]) }));
      expect(await fitness.vo2MaxHistory({ sport: 'running' })).toEqual(expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ value_number: 58.5, sport: 'generic' })]),
        provenance: expect.objectContaining({ requestedSport: 'running', sourceSport: 'generic' }),
      }));
      const monthlyAggregate = await analytics.aggregate({
        dataset: 'daily_health',
        metrics: [{ column: 'hrv_ms', operation: 'mean', as: 'mean_hrv' }],
        timeBucket: 'month',
        orderBy: { column: 'time_bucket', direction: 'asc' },
      });
      expect(monthlyAggregate.data).toEqual(expect.arrayContaining([expect.objectContaining({ time_bucket: expect.any(String) })]));
      await expect(fitness.powerCurveTrend({ durations: [5, 300] })).rejects.toThrow('require an explicit sport or sportFamily');
      expect(await fitness.powerCurveTrend({ sportFamily: 'running', durations: [5, 300], sourceQuality: 'garmin_fit_derived' })).toEqual(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ durationLabel: '5 s', sport: 'trail_running' })]) }));
      expect(await fitness.powerCoverageReport({ sportFamily: 'running' })).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          activityCoverage: [expect.objectContaining({ sport: 'trail_running', activities: 1, powered_activities: 1, datapoints: 2 })],
          durationInventory: expect.arrayContaining([expect.objectContaining({ durationLabel: '5 s', datapoints: 1, min_power_w: 390, max_power_w: 390 })]),
        }),
      }));
      expect(await queryReadOnlyData(repository, { sql: "SELECT avg_power FROM activity_summary_facts WHERE activity_source_id = 'garmin:garmin-run-1'" }))
        .toEqual(expect.objectContaining({ data: [{ avg_power: null }] }));
      expect(await fitness.latestCyclingActivities()).toEqual(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ activity_source_id: 'garmin:garmin-ride-1' })]) }));
      expect(await fitness.cyclingProgressReport()).toEqual(expect.objectContaining({ data: expect.objectContaining({ monthlyVolume: expect.any(Array) }) }));
      const activities = await new ActivityDiscoveryService(repository).findActivities({ sports: ['road_biking'], distanceKm: [40, 45] });
      expect(activities).toEqual(expect.objectContaining({ totalRows: 1, truncated: false, data: expect.arrayContaining([expect.objectContaining({ activity_source_id: 'garmin:garmin-ride-1' })]) }));
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
    const hydrateStravaActivity = vi.fn(async () => ({ status: 'completed', stravaActivityId: 'strava-ride-1' }));
    const server = createCatenceMcpServer(paths, { hydrateStravaActivity });
    const client = new Client({ name: 'catence-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['catence_status', 'describe_dataset', 'read_series', 'query_read_only_data', 'search_context', 'get_ftp_history', 'get_vo2max_history', 'find_activities', 'get_swim_laps', 'swim_progress_report', 'get_activity_segments', 'power_curve_trend', 'power_coverage_report', 'latest_cycling_activities', 'cycling_progress_report', 'hydrate_recent_strava_activities', 'review_daily_recovery_load', 'review_weekly_training', 'review_activity_deep_dive', 'wellness_correlate', 'wellness_baselines', 'wellness_anomalies', 'wellness_coverage']));
      expect(client.getInstructions()).toContain('call get_activity_segments');
      const weeklyReview = await client.callTool({ name: 'review_weekly_training', arguments: { endDate: '2026-01-08' } });
      const weeklyPayload = JSON.parse(((weeklyReview as { content: Array<{ text: string }> }).content[0]).text) as { data: { startDate: string; endDate: string; health: unknown[]; training: unknown[] } };
      expect(weeklyPayload.data).toEqual(expect.objectContaining({ startDate: '2026-01-02', endDate: '2026-01-08', health: expect.any(Array), training: expect.any(Array) }));
      const prompt = await client.getPrompt({ name: 'activity_deep_dive', arguments: { activityId: 'garmin:garmin-ride-1' } });
      expect(prompt.messages[0]?.content).toEqual(expect.objectContaining({ text: expect.stringContaining('review_activity_deep_dive') }));
      const result = await client.callTool({ name: 'read_series', arguments: { dataset: 'daily_health', metrics: ['hrv_ms'], startDate: '2026-01-01', endDate: '2026-01-08', resolution: 'day' } });
      const payload = JSON.parse(((result as { content: Array<{ text: string }> }).content[0]).text) as { data: unknown[] };
      expect(payload.data).toHaveLength(8);
      const wellnessResult = await client.callTool({ name: 'wellness_baselines', arguments: { metrics: ['hrv_ms'], endDate: '2026-01-08', windowDays: 8 } });
      const wellnessPayload = JSON.parse(((wellnessResult as { content: Array<{ text: string }> }).content[0]).text) as { data: Array<{ metric: string }> };
      expect(wellnessPayload.data).toEqual([expect.objectContaining({ metric: 'hrv_ms' })]);
      const ftpResult = await client.callTool({ name: 'get_ftp_history', arguments: { sport: 'cycling' } });
      const ftpPayload = JSON.parse(((ftpResult as { content: Array<{ text: string }> }).content[0]).text) as { data: { preferredSeries: unknown[] } };
      expect(ftpPayload.data.preferredSeries).toHaveLength(1);
      const datasetResult = await client.callTool({ name: 'describe_dataset', arguments: { dataset: 'training_metric_observations' } });
      const datasetPayload = JSON.parse(((datasetResult as { content: Array<{ text: string }> }).content[0]).text) as { data: { dataset: { name: string }; coverage: { row_count: number } | null } };
      expect(datasetPayload.data.dataset.name).toBe('training_metric_observations');
      expect(datasetPayload.data.coverage?.row_count).toBeGreaterThan(0);
      const segmentResult = await client.callTool({ name: 'get_activity_segments', arguments: { activityId: 'garmin:garmin-ride-1' } });
      const segmentPayload = JSON.parse(((segmentResult as { content: Array<{ text: string }> }).content[0]).text) as { data: { segments: Array<{ segment_id: string; segment_name: string }> } };
      expect(hydrateStravaActivity).toHaveBeenCalledWith(paths, 'garmin:garmin-ride-1', false);
      expect(segmentPayload.data.segments).toEqual([expect.objectContaining({ segment_id: 'segment-1', segment_name: 'Test climb' })]);
      const resource = await client.readResource({ uri: 'catence://summary/2026-01-01/2026-01-08' });
      expect(resource.contents[0]?.mimeType).toBe('application/json');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
