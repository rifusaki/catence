import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  ActivityDiscoveryService,
  AnalyticsService,
  loadCatalog,
  type CatalogPaths,
  configuredMcpRateLimit,
  DataWriteBusyError,
  DATASET_CATALOG,
  demoStoreMetadata,
  DetachedSyncBusyError,
  FitnessService,
  getDataset,
  hydrateStravaActivity,
  hydrateStravaSegmentHistory,
  jsonSafe,
  loadCatenceConfig,
  openReadOnlyRepository,
  queryReadOnlyData,
  QueryValidationError,
  ReadOnlyDatabaseError,
  ReadOnlyRepository,
  resolveAthlete,
  resolveCatalogPaths,
  searchContext,
  SlidingWindowLimiter,
  startDetachedSync,
  StravaEnrichmentError,
  StravaRateLimitError,
  SwimmingService,
  type CatencePaths,
  type DataFilter,
  WELLNESS_METRICS,
  WellnessService,
} from '../../runtime/index.js';

const filterSchema = z.object({
  column: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'between', 'contains']),
  value: z.unknown(),
});
const resolutionSchema = z.enum(['raw', '1m', '5m', '15m', '1h', 'day', 'week', 'auto']);
const seriesInput = {
  dataset: z.string().min(1),
  metrics: z.array(z.string().min(1)).min(1).max(12),
  filters: z.array(filterSchema).max(50).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  activityId: z.string().min(1).optional(),
  resolution: resolutionSchema.optional(),
  cursor: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(1_000).optional(),
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type StravaActivityHydrator = typeof hydrateStravaActivity;

type McpDependencies = {
  hydrateStravaActivity?: StravaActivityHydrator;
  startDetachedSync?: typeof startDetachedSync;
};

type AthleteResolution = { athlete: { id: string; label: string }; paths: CatencePaths };

function isCatalogPaths(value: CatencePaths | CatalogPaths): value is CatalogPaths {
  return 'catalog' in value;
}

const MCP_INSTRUCTIONS = [
  'For a selected activity\'s Strava segments, climb segments, grade by segment, KOM/PR, or per-segment analysis, call get_activity_segments after identifying the activity.',
  'That tool performs the targeted Strava hydration itself. Do not say segment data is unavailable before it returns; if it reports not_found, ambiguous, authorization, throttling, or an error, report that exact outcome instead.',
  'For Garmin running VO₂max, call get_vo2max_history with sport: running. Garmin stores the source value as generic; returned rows preserve that source label.',
  'Aggregate elevation alone cannot support an individual-climb conclusion. Use source-specific facts and their stated coverage.',
].join(' ');

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(jsonSafe(value), null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  const classified = error instanceof DetachedSyncBusyError
    ? { code: 'sync_in_progress', message: error.message, retryable: true, runId: error.runId }
    : error instanceof DataWriteBusyError
      ? { code: 'data_sync_in_progress', message: error.message, retryable: true }
      : error instanceof StravaRateLimitError
      ? { code: 'rate_limited', message: error.message, retryable: true, retryAfterSeconds: error.retryAfterSeconds ?? null }
      : error instanceof StravaEnrichmentError
        ? { code: 'strava_connection_error', message: error.message }
        : error instanceof ReadOnlyDatabaseError
          ? { code: error.code, message: error.message }
          : error instanceof QueryValidationError
            ? { code: 'invalid_request', message: error.message }
            : { code: 'data_unavailable', message: error instanceof Error ? error.message : String(error) };
  return { ...textResult({ data: null, provenance: {}, query: {}, caveats: [classified.message], error: classified }), isError: true };
}

function hydrationFailure(error: unknown): { code: string; message: string; retryable?: boolean; retryAfterSeconds?: number | null } {
  if (error instanceof DataWriteBusyError) return { code: 'data_sync_in_progress', message: error.message, retryable: true };
  if (error instanceof StravaRateLimitError) return { code: 'rate_limited', message: error.message, retryable: true, retryAfterSeconds: error.retryAfterSeconds ?? null };
  if (error instanceof StravaEnrichmentError) return { code: 'strava_connection_error', message: error.message };
  return { code: 'data_unavailable', message: error instanceof Error ? error.message : String(error) };
}

async function useRepository<T>(paths: CatencePaths, fn: (repository: ReadOnlyRepository) => Promise<T>): Promise<T> {
  const repository = await openReadOnlyRepository(paths);
  try {
    return await fn(repository);
  } finally {
    await repository.close();
  }
}

function resource(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jsonSafe(value), null, 2) }] };
}

function stravaActivityIds(hydration: unknown): string[] {
  const identifiers = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.stravaActivityId === 'string' && record.stravaActivityId) identifiers.add(record.stravaActivityId);
    if (Array.isArray(record.childOutcomes)) {
      for (const outcome of record.childOutcomes) {
        if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) collect((outcome as Record<string, unknown>).result);
      }
    }
  };
  collect(hydration);
  return [...identifiers];
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

async function activitySegments(repository: ReadOnlyRepository, activityId: string, hydratedStravaActivityIds: string[], limit: number): Promise<Array<Record<string, unknown>>> {
  const hydratedSourceClause = hydratedStravaActivityIds.length
    ? ` OR source.activity_source_id IN (${hydratedStravaActivityIds.map((_, index) => `$hydratedSource${index}`).join(', ')})`
    : '';
  const values: Record<string, unknown> = { activityId, limit };
  for (const [index, stravaActivityId] of hydratedStravaActivityIds.entries()) values[`hydratedSource${index}`] = `strava:${stravaActivityId}`;
  return repository.rows(`
    WITH selected_activity AS (
      SELECT activity_id FROM activity_sources WHERE activity_source_id = $activityId
      UNION
      SELECT activity_id FROM activities WHERE activity_id = $activityId
    )
    SELECT effort.activity_source_id, effort.effort_id, effort.segment_id,
      segment.name AS segment_name, segment.average_grade_pct, segment.maximum_grade_pct,
      segment.climb_category, segment.total_elevation_gain_m,
      effort.elapsed_s, effort.moving_s, effort.distance_m, effort.average_watts,
      effort.average_hr, effort.max_hr, effort.average_cadence, effort.device_watts,
      effort.pr_rank, effort.kom_rank, cast(effort.started_at AS VARCHAR) AS started_at,
      effort.raw_object_hash
    FROM activity_segments AS effort
    JOIN activity_sources AS source USING (activity_source_id)
    LEFT JOIN strava_segments AS segment USING (segment_id)
    WHERE (source.activity_id IN (SELECT activity_id FROM selected_activity)${hydratedSourceClause})
    ORDER BY effort.started_at ASC NULLS LAST, effort.effort_id ASC
    LIMIT $limit
  `, values);
}

export function createCatenceMcpServer(paths: CatencePaths | CatalogPaths = resolveCatalogPaths(), dependencies: McpDependencies = {}): McpServer {
  const server = new McpServer({ name: 'catence', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  const hydrateActivity = dependencies.hydrateStravaActivity ?? hydrateStravaActivity;
  const startSync = dependencies.startDetachedSync ?? startDetachedSync;
  const catalogPaths = isCatalogPaths(paths) ? paths : null;
  const staticPaths: CatencePaths | null = isCatalogPaths(paths) ? null : paths;
  const scope = new AsyncLocalStorage<AthleteResolution>();
  const activePaths = (): CatencePaths => scope.getStore()?.paths ?? staticPaths ?? (() => { throw new Error('athleteId is required. Call list_athletes to inspect the configured catalog.'); })();
  const activeAthlete = () => scope.getStore()?.athlete;
  const limiter = new SlidingWindowLimiter();
  const athleteIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
  const promptAthleteSchema: Record<string, z.ZodType> = catalogPaths ? { athleteId: athleteIdSchema } : {};

  if (catalogPaths) {
    server.registerTool('list_athletes', {
      title: 'List configured athletes',
      description: 'List athlete IDs and labels available to this shared Catence agent. No personal metrics are returned.',
    }, async (): Promise<ToolResult> => {
      try {
        const catalog = await loadCatalog(catalogPaths);
        return textResult({ data: { defaultAthleteId: catalog.defaultAthleteId, athletes: catalog.athletes } });
      } catch (error) { return errorResult(error); }
    });
    const originalRegister = server.registerTool.bind(server) as unknown as (name: string, configuration: Record<string, unknown>, handler: unknown) => unknown;
    (server as unknown as { registerTool: (name: string, configuration: Record<string, unknown>, handler: unknown) => unknown }).registerTool = (name, configuration, handler) => {
      const originalInput = configuration.inputSchema as Record<string, z.ZodType> | undefined;
      return originalRegister(name, {
        ...configuration,
        description: `${String(configuration.description ?? '')} Requires athleteId from list_athletes.`,
        inputSchema: { athleteId: athleteIdSchema, ...(originalInput ?? {}) },
      }, handler);
    };
  }

  const tool = <T extends Record<string, unknown>>(name: string, fn: (input: T) => Promise<unknown>) => async (rawInput: T & { athleteId?: string }): Promise<ToolResult> => {
    try {
      const selected = catalogPaths
        ? await resolveAthlete(catalogPaths, rawInput.athleteId ?? '')
        : null;
      const run = async (): Promise<ToolResult> => {
        const currentPaths = activePaths();
        const config = await loadCatenceConfig(currentPaths);
        const decision = limiter.check(`${activeAthlete()?.id ?? 'local'}:tool:${name}`, configuredMcpRateLimit(config, 'tools', name));
        if (!decision.allowed) return { ...textResult({ data: null, ...(activeAthlete() ? { athlete: activeAthlete() } : {}), error: { code: 'rate_limited', message: `MCP tool ${name} is locally rate limited.`, retryAfterSeconds: decision.retryAfterSeconds } }), isError: true };
        const { athleteId: _athleteId, ...input } = rawInput;
        const value = await fn(input as T);
        const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { data: value };
        const demoStore = await demoStoreMetadata(currentPaths);
        const caveats = Array.isArray(result.caveats) ? result.caveats : [];
        return textResult({
          ...result,
          ...(activeAthlete() ? { athlete: activeAthlete() } : {}),
          ...(demoStore ? { demoStore: { generated: true, seed: demoStore.seed, days: demoStore.days, startDate: demoStore.startDate, endDate: demoStore.endDate }, caveats: [...caveats, 'This response uses Catence generated demo data, not personal measurements.'] } : {}),
        });
      };
      // `return await` matters here: a bare `return run()` would let a
      // rejected promise escape the try block, bypassing the classified
      // errorResult payload entirely.
      if (selected) return await scope.run(selected, run);
      return await run();
    } catch (error) { return errorResult(error); }
  };
  const resourceLimit = async (name: string, uri: URL) => {
    try {
      const config = await loadCatenceConfig(activePaths());
      const decision = limiter.check(`resource:${name}`, configuredMcpRateLimit(config, 'resources', name));
      if (!decision.allowed) return resource(uri, { error: { code: 'rate_limited', message: `MCP resource ${name} is locally rate limited.`, retryAfterSeconds: decision.retryAfterSeconds } });
      return null;
    } catch (error) { return resource(uri, { error: JSON.parse(errorResult(error).content[0]!.text) }); }
  };

  server.registerPrompt('daily_recovery_load_review', {
    title: 'Daily recovery and load review',
    description: 'Ask for a source-cited recovery and training-load review for one date.',
    argsSchema: { ...promptAthleteSchema, date: z.string().date().optional() },
  }, ({ date, ...input }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Run review_daily_recovery_load for ${date ?? utcDate()}${typeof (input as { athleteId?: unknown }).athleteId === 'string' ? ` with athleteId ${(input as { athleteId: string }).athleteId}` : ''}. Summarize only returned evidence, name data gaps, and do not present a training prescription as fact.` },
    }],
  }));

  server.registerPrompt('weekly_training_review', {
    title: 'Weekly training review',
    description: 'Ask for a source-cited seven-day training review ending on an optional date.',
    argsSchema: { ...promptAthleteSchema, endDate: z.string().date().optional() },
  }, ({ endDate, ...input }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Run review_weekly_training ending on ${endDate ?? utcDate()}${typeof (input as { athleteId?: unknown }).athleteId === 'string' ? ` with athleteId ${(input as { athleteId: string }).athleteId}` : ''}. Explain volume, load, and recovery evidence with dates and coverage caveats.` },
    }],
  }));

  server.registerPrompt('activity_deep_dive', {
    title: 'Activity deep dive',
    description: 'Ask for an evidence-first deep dive into one canonical Catence activity.',
    argsSchema: { ...promptAthleteSchema, activityId: z.string().min(1) },
  }, ({ activityId, ...input }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Run review_activity_deep_dive for ${activityId}${typeof (input as { athleteId?: unknown }).athleteId === 'string' ? ` with athleteId ${(input as { athleteId: string }).athleteId}` : ''}. Use its source records and intervals first; load read_series only if a specific sampled metric is needed.` },
    }],
  }));

  server.registerTool('catence_status', {
    title: 'Catence data status',
    description: 'Read sync state, data coverage, entity counts, stream availability, unresolved errors, and retrieval-index freshness. Read-only.',
  }, tool('catence_status', async () => useRepository(activePaths(), async (repository) => ({
    data: { ...(await repository.status()), ...(await repository.coverage()) },
    provenance: { database: 'read-only DuckDB snapshot' }, query: {}, caveats: [],
  }))));

  server.registerTool('catence_sync_progress', {
    title: 'Catence sync progress',
    description: 'Read live progress heartbeats for active sync runs, plus the most recent completed or interrupted runs. Read-only.',
  }, tool('catence_sync_progress', async () => useRepository(activePaths(), async (repository) => ({
    data: await repository.progress(),
    provenance: { database: 'read-only DuckDB snapshot' }, query: {}, caveats: [],
  }))));

  server.registerTool('start_detached_sync', {
    title: 'Start a detached data sync',
    description:
      'Write-only sync trigger, named like the other explicit lock-guarded write tools. Spawns one detached catence-data sync process for this athlete and returns immediately with the run handle and log file; it refuses while another sync run is active. Track the run with catence_sync_progress; this tool never waits for completion.',
    inputSchema: {
      provider: z.enum(['intervals', 'garmin', 'strava', 'all']).optional(),
      from: z.string().date().optional(),
      refresh: z.boolean().optional(),
    },
  }, tool('start_detached_sync', async (input) => {
    const paths = activePaths();
    const athleteId = activeAthlete()?.id ?? 'local';
    const handle = await startSync({ paths, athleteId, provider: input.provider, from: input.from, refresh: input.refresh });
    return {
      data: { ...handle, progressTool: 'catence_sync_progress' },
      provenance: { operation: 'detached_sync_spawn' },
      query: { ...input },
      caveats: [
        'The sync runs in its own process and keeps running if this session ends; its log file records the full worker output.',
        'Only one sync run may be active per athlete store.',
      ],
    };
  }));

  server.registerTool('review_daily_recovery_load', {
    title: 'Review daily recovery and training load',
    description: 'Return source-cited daily health, training, and nutrition facts for a recovery/load review. It does not prescribe a training plan.',
    inputSchema: { date: z.string().date().optional() },
  }, tool('review_daily_recovery_load', async (input) => {
    const date = input.date ?? utcDate();
    return useRepository(activePaths(), async (repository) => ({
      data: { date, ...(await repository.summary(date, date)) },
      provenance: { relations: ['daily_health', 'canonical_activity_training', 'nutrition_days'], database: 'read-only DuckDB snapshot' },
      query: { date },
      caveats: [
        'This is an evidence bundle for an LLM or coach to interpret; it is not a generated training prescription.',
        'Absent health, training, or nutrition rows indicate unavailable source coverage rather than a zero value.',
      ],
    }));
  }));

  server.registerTool('review_weekly_training', {
    title: 'Review seven days of training',
    description: 'Return source-cited health, training, and nutrition facts for the seven-day period ending on an optional date. It does not prescribe a training plan.',
    inputSchema: { endDate: z.string().date().optional() },
  }, tool('review_weekly_training', async (input) => {
    const endDate = input.endDate ?? utcDate();
    const startDate = subtractDays(endDate, 6);
    return useRepository(activePaths(), async (repository) => ({
      data: { startDate, endDate, ...(await repository.summary(startDate, endDate)) },
      provenance: { relations: ['daily_health', 'canonical_activity_training', 'nutrition_days'], database: 'read-only DuckDB snapshot' },
      query: { startDate, endDate },
      caveats: [
        'This is an evidence bundle for an LLM or coach to interpret; it is not a generated training prescription.',
        'A day without a row is unavailable source coverage, not an inferred rest day.',
      ],
    }));
  }));

  server.registerTool('review_activity_deep_dive', {
    title: 'Review one activity in depth',
    description: 'Return canonical activity identity, source summaries, and structured intervals. Call read_series separately only when a specific sampled metric is required.',
    inputSchema: { activityId: z.string().min(1) },
  }, tool('review_activity_deep_dive', async (input) => useRepository(activePaths(), async (repository) => {
    const activity = await repository.activity(input.activityId);
    return {
      data: activity,
      provenance: { relations: ['activities', 'activity_sources', 'activity_summary_facts', 'activity_interval_facts'], database: 'read-only DuckDB snapshot' },
      query: input,
      caveats: activity
        ? ['This workflow does not infer interval structure or sampled metrics that providers did not supply. Use read_series for a bounded requested metric.']
        : ['No canonical activity matched this activityId. Use find_activities before drawing conclusions.'],
    };
  })));

  server.registerTool('describe_data', {
    title: 'Describe available Catence datasets',
    description: 'List cataloged datasets, fields, units, permitted filters/groupings, providers, and time coverage. Read-only.',
  }, tool('describe_data', async () => useRepository(activePaths(), async (repository) => ({
    data: { datasets: repository.catalog(), ...(await repository.coverage()) },
    provenance: { catalog: 'Catence catalog, restricted to analytical views' }, query: {}, caveats: ['activity_samples is available only through read_series or aggregate_data and only reads registered Parquet stream manifests.'],
  }))));

  server.registerTool('describe_dataset', {
    title: 'Describe one Catence dataset',
    description: 'Read a compact schema, permitted filters/groupings, provenance fields, and coverage for one cataloged dataset. Read-only.',
    inputSchema: { dataset: z.string().min(1) },
  }, tool('describe_dataset', async (input) => useRepository(activePaths(), async (repository) => {
    const dataset = getDataset(input.dataset);
    const coverage = (await repository.coverage()).coverage as Array<Record<string, unknown>>;
    const observedValues = dataset.name === 'training_metric_observations'
      ? await (async () => {
        const [sports, metricNames, units, sourceTypes] = await Promise.all([
          repository.rows<{ sport: string }>(`SELECT distinct sport FROM training_metric_observations WHERE sport IS NOT NULL ORDER BY sport ASC`),
          repository.rows<{ metric_name: string }>(`SELECT distinct metric_name FROM training_metric_observations ORDER BY metric_name ASC`),
          repository.rows<{ unit: string }>(`SELECT distinct unit FROM training_metric_observations WHERE unit IS NOT NULL ORDER BY unit ASC`),
          repository.rows<{ source_type: string }>(`SELECT distinct source_type FROM training_metric_observations ORDER BY source_type ASC`),
        ]);
        return { sports: sports.map((row) => row.sport), metricNames: metricNames.map((row) => row.metric_name), units: units.map((row) => row.unit), sourceTypes: sourceTypes.map((row) => row.source_type) };
      })()
      : undefined;
    return {
      data: { dataset, coverage: coverage.find((item) => item.dataset === dataset.name) ?? null, observedValues },
      provenance: { catalog: 'Catence catalog', database: 'read-only DuckDB snapshot' }, query: input, caveats: [],
    };
  })));

  server.registerTool('read_series', {
    title: 'Read a bounded time series', description: 'Read cataloged numeric series with deterministic cursor pagination and automatic stream downsampling. metrics must be numeric catalog columns; place identifiers and other strings in filters. Call describe_dataset first if the fields are uncertain.', inputSchema: seriesInput,
  }, tool('read_series', async (input) => useRepository(activePaths(), (repository) => new AnalyticsService(repository).readSeries({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('aggregate_data', {
    title: 'Aggregate cataloged data', description: 'Declarative aggregation over one cataloged dataset. A timeBucket adds a time_bucket field, which can be used in orderBy. No joins, arbitrary expressions, or file paths.',
    inputSchema: {
      dataset: z.string().min(1),
      metrics: z.array(z.object({ column: z.string().min(1), operation: z.enum(['count', 'sum', 'mean', 'min', 'max', 'percentile']), percentile: z.number().gt(0).lt(1).optional(), as: z.string().min(1).max(64).optional() })).min(1).max(12),
      dimensions: z.array(z.string().min(1)).max(8).optional(), filters: z.array(filterSchema).max(50).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), timeBucket: z.enum(['day', 'week', 'month']).optional(), orderBy: z.object({ column: z.string().min(1), direction: z.enum(['asc', 'desc']).optional() }).optional(), limit: z.number().int().min(1).max(500).optional(),
    },
  }, tool('aggregate_data', async (input) => useRepository(activePaths(), (repository) => new AnalyticsService(repository).aggregate({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('analyze_series', {
    title: 'Analyze a descriptive series', description: 'Run deterministic rolling statistics, baselines, correlations, seasonal comparisons, or trends on a cataloged series.',
    inputSchema: { ...seriesInput, analysis: z.enum(['rolling_mean', 'rolling_median', 'baseline_change', 'z_score', 'pearson', 'spearman', 'seasonal_comparison', 'linear_trend', 'theil_sen_trend']), compareMetric: z.string().min(1).optional(), window: z.number().int().min(2).max(100).optional() },
  }, tool('analyze_series', async (input) => useRepository(activePaths(), (repository) => new AnalyticsService(repository).analyzeSeries({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('fit_series_model', {
    title: 'Fit a descriptive series model', description: 'Fit a bounded OLS, Theil–Sen, quadratic, or cubic descriptive model. Not a sport-performance model.',
    inputSchema: { ...seriesInput, model: z.enum(['ols_linear', 'theil_sen_linear', 'polynomial_2', 'polynomial_3']), xMetric: z.string().min(1).optional(), yMetric: z.string().min(1).optional() },
  }, tool('fit_series_model', async (input) => useRepository(activePaths(), (repository) => new AnalyticsService(repository).fitSeriesModel({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('wellness_correlate', {
    title: 'Correlate recovery and training metrics',
    description: 'Calculate a compact daily Pearson or Spearman correlation between curated wellness and training metrics, with an optional -7 through +7 day lag scan. Descriptive only.',
    inputSchema: {
      metricA: z.enum(WELLNESS_METRICS), metricB: z.enum(WELLNESS_METRICS), startDate: z.string().date().optional(), endDate: z.string().date().optional(),
      method: z.enum(['pearson', 'spearman']).optional(), lagDays: z.number().int().min(-30).max(30).optional(), scanLags: z.boolean().optional(),
    },
  }, tool('wellness_correlate', async (input) => useRepository(activePaths(), (repository) => new WellnessService(repository).correlate(input))));

  server.registerTool('wellness_baselines', {
    title: 'Read personal wellness baselines',
    description: 'Return trailing means, standard-deviation bands, latest values, and latest z-scores for common recovery and training metrics. Missing values remain missing.',
    inputSchema: { metrics: z.array(z.enum(WELLNESS_METRICS)).min(1).max(12).optional(), endDate: z.string().date().optional(), windowDays: z.number().int().min(7).max(365).optional() },
  }, tool('wellness_baselines', async (input) => useRepository(activePaths(), (repository) => new WellnessService(repository).baselines(input))));

  server.registerTool('wellness_anomalies', {
    title: 'Find statistical wellness anomalies',
    description: 'Find daily recovery and wellness outliers by z-score and group dates with anomalies across multiple signals. This does not diagnose or prescribe.',
    inputSchema: { metrics: z.array(z.enum(WELLNESS_METRICS)).min(1).max(12).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), zThreshold: z.number().min(1).max(5).optional() },
  }, tool('wellness_anomalies', async (input) => useRepository(activePaths(), (repository) => new WellnessService(repository).anomalies(input))));

  server.registerTool('wellness_coverage', {
    title: 'Inspect wellness data coverage',
    description: 'Report present and missing dates for curated wellness/training metrics, plus unresolved extraction errors. Missing data is never interpreted as rest or a health outcome.',
    inputSchema: { metrics: z.array(z.enum(WELLNESS_METRICS)).min(1).max(12).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional() },
  }, tool('wellness_coverage', async (input) => useRepository(activePaths(), (repository) => new WellnessService(repository).coverage(input))));

  server.registerTool('get_ftp_history', {
    title: 'Get dated FTP history',
    description: 'Return normalized cycling FTP settings and activity-summary observations with source-aware preferred daily values. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), sourcePreference: z.enum(['settings', 'settings_then_activity', 'all']).optional() },
  }, tool('get_ftp_history', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).ftpHistory(input))));

  server.registerTool('get_vo2max_history', {
    title: 'Get sport-specific VO₂max history',
    description: 'Return normalized Garmin VO₂max observations for exactly one sport. For running, pass sport: running (or run): Garmin supplies that series with raw sport generic, which is preserved in each row. Cycling remains separate. Omit sport only to inspect available source labels. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional() },
  }, tool('get_vo2max_history', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).vo2MaxHistory(input))));

  server.registerTool('find_activities', {
    title: 'Find activities and likely races',
    description: 'Find canonical activities by sport, distance, name, and date. Results are paginated and transparently flag likely-race signals without claiming provider-confirmed race metadata. Read-only.',
    inputSchema: {
      sports: z.array(z.string().min(1)).min(1).max(12).optional(),
      distanceKm: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
      nameContains: z.array(z.string().min(1)).min(1).max(12).optional(),
      startDate: z.string().date().optional(), endDate: z.string().date().optional(),
      sort: z.enum(['date_desc', 'date_asc']).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).optional(),
    },
  }, tool('find_activities', async (input) => useRepository(activePaths(), (repository) => new ActivityDiscoveryService(repository).findActivities(input))));

  server.registerTool('get_swim_laps', {
    title: 'Read explicit swim lengths and grouped sets',
    description: 'Return source-aware swim lengths when a provider actually supplied them, plus Garmin detected and Intervals.icu auto-detected sets. A missing length list is reported as unavailable; laps are never reconstructed from samples.',
    inputSchema: { activityId: z.string().min(1), provider: z.enum(['garmin', 'intervals']).optional() },
  }, tool('get_swim_laps', async (input) => useRepository(activePaths(), (repository) => new SwimmingService(repository).swimLaps(input))));

  server.registerTool('swim_progress_report', {
    title: 'Build a source-aware swim progress report',
    description: 'Compare Garmin swimming summaries and data completeness over a date range, optionally within one pool length. It does not derive pace trends from moving time divided by distance.',
    inputSchema: { startDate: z.string().date().optional(), endDate: z.string().date().optional(), poolLengthM: z.number().positive().max(200).optional() },
  }, tool('swim_progress_report', async (input) => useRepository(activePaths(), (repository) => new SwimmingService(repository).swimProgressReport(input))));

  server.registerTool('get_activity_segments', {
    title: 'Hydrate and read an activity’s Strava segments',
    description: 'For a selected activity’s segments, climbs, KOM/PRs, or per-segment analysis: automatically hydrate the matching Strava activity before returning its persisted segment efforts. Use this before saying segment data is unavailable.',
    inputSchema: { activityId: z.string().min(1), refresh: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() },
  }, tool('get_activity_segments', async (input) => {
    const hydration = await hydrateActivity(activePaths(), input.activityId, input.refresh ?? false);
    const hydratedStravaActivityIds = stravaActivityIds(hydration);
    const segments = await useRepository(activePaths(), (repository) => activitySegments(repository, input.activityId, hydratedStravaActivityIds, input.limit ?? 200));
    return {
      data: { hydration, hydratedStravaActivityIds, segments },
      provenance: { provider: 'strava', relations: ['activity_segments', 'strava_segments'], operation: 'targeted_activity_hydration_then_read' },
      query: { ...input, refresh: input.refresh ?? false, limit: input.limit ?? 200 },
      caveats: [
        'Strava hydration is attempted before these rows are read. If segments is empty, inspect the hydration status and match diagnostics before treating segment data as unavailable.',
        'Segment verification is unavailable from Strava public segment data and is never inferred.',
      ],
    };
  }));

  server.registerTool('power_curve_trend', {
    title: 'Read labelled power-curve trends',
    description: 'Return monthly bests for selected power durations from an explicit sport or sport family, including the supporting activity and source type. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), sportFamily: z.enum(['cycling', 'running']).optional(), durations: z.array(z.number().int().min(1).max(86_400)).min(1).max(12).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), sourceQuality: z.enum(['all', 'garmin_fit_derived']).optional() },
  }, tool('power_curve_trend', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).powerCurveTrend(input))));

  server.registerTool('power_coverage_report', {
    title: 'Inspect FIT-derived power coverage',
    description: 'Report powered activities and the complete duration-best inventory for an explicit sport or sport family. Uses Garmin FIT-derived power, not sparse activity summaries. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), sportFamily: z.enum(['cycling', 'running']).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), sourceQuality: z.enum(['all', 'garmin_fit_derived']).optional() },
  }, tool('power_coverage_report', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).powerCoverageReport(input))));

  server.registerTool('latest_cycling_activities', {
    title: 'List latest cycling activities',
    description: 'List Garmin cycling source records without duplicate Intervals summaries, optionally flagging multisport parent records. Read-only.',
    inputSchema: { startDate: z.string().date().optional(), endDate: z.string().date().optional(), includeMultisport: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, tool('latest_cycling_activities', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).latestCyclingActivities(input))));

  server.registerTool('cycling_progress_report', {
    title: 'Build a cycling progress report',
    description: 'Combine source-aware FTP and VO₂max histories with monthly canonical volume/load and labelled power-curve trends. Read-only and descriptive.',
    inputSchema: { startDate: z.string().date().optional(), endDate: z.string().date().optional() },
  }, tool('cycling_progress_report', async (input) => useRepository(activePaths(), (repository) => new FitnessService(repository).cyclingProgressReport(input))));

  server.registerTool('query_read_only_data', {
    title: 'Query cataloged read-only data', description: 'Advanced fallback after describe_data/describe_dataset: one parameterized SELECT or WITH … SELECT over cataloged views only. Do not query information_schema, DuckDB system tables, or uncataloged physical relations. Results use deterministic cursor pagination and always report whether they are incomplete. Filesystem access, extensions, DDL, and mutation are rejected.',
    inputSchema: { sql: z.string().min(1).max(20_000), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).refine((value) => Object.keys(value).length <= 100, 'At most 100 bind values are allowed.').optional(), cursor: z.string().min(1).optional(), pageSize: z.number().int().min(1).max(500).optional() },
  }, tool('query_read_only_data', async (input) => useRepository(activePaths(), (repository) => queryReadOnlyData(repository, input))));

  server.registerTool('search_context', {
    title: 'Search generated context', description: 'Search compact generated activity, plan, nutrition, and message context. Results identify authoritative follow-up tools rather than making numerical claims.',
    inputSchema: { query: z.string().min(2).max(500), filters: z.array(z.object({ column: z.enum(['provider', 'entity_type', 'occurred_on']), op: z.enum(['eq', 'in', 'between']), value: z.unknown() })).max(20).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, tool('search_context', async (input) => useRepository(activePaths(), (repository) => searchContext(repository, input))));

  server.registerTool('hydrate_strava_activity', {
    title: 'Hydrate one activity from Strava',
    description: 'Write-only targeted enrichment. Safely matches exactly one Catence activity/source to Strava, then archives and persists its activity detail, gear assignment, and segment efforts. For a segment/climb request, prefer get_activity_segments, which invokes this prerequisite automatically.',
    inputSchema: { activityId: z.string().min(1), refresh: z.boolean().optional() },
  }, tool('hydrate_strava_activity', async (input) => {
    const data = await hydrateActivity(activePaths(), input.activityId, input.refresh ?? false);
    return { data, coverage: await useRepository(activePaths(), (repository) => repository.coverage()), provenance: { provider: 'strava', operation: 'activity_detail', archivedBeforeNormalization: true }, caveats: ['Segment verification is unavailable from Strava public segment data and is never inferred.'] };
  }));

  server.registerTool('hydrate_recent_strava_activities', {
    title: 'Hydrate several recent Strava activities',
    description: 'Write-only targeted batch enrichment. Select an explicit list or a bounded date/sport window; Catence hydrates one activity at a time and reports every outcome.',
    inputSchema: z.object({
      activityIds: z.array(z.string().min(1)).min(1).max(20).optional(),
      startDate: z.string().date().optional(), endDate: z.string().date().optional(), sports: z.array(z.string().min(1)).min(1).max(12).optional(),
      limit: z.number().int().min(1).max(20).optional(), refresh: z.boolean().optional(),
    }).refine((value) => Boolean(value.activityIds?.length) || Boolean(value.startDate && value.endDate), 'Provide activityIds or both startDate and endDate.'),
  }, tool('hydrate_recent_strava_activities', async (input) => {
    const activityIds = input.activityIds
      ? [...new Set(input.activityIds)]
      : await useRepository(activePaths(), async (repository) => {
        const values: Record<string, unknown> = {
          startDate: input.startDate!, endDate: `${input.endDate!}T23:59:59.999Z`, limit: input.limit ?? 20,
        };
        const clauses = [
          "source.provider = 'garmin'",
          'activity.started_at_utc >= cast($startDate AS TIMESTAMPTZ)',
          'activity.started_at_utc <= cast($endDate AS TIMESTAMPTZ)',
        ];
        if (input.sports?.length) {
          const placeholders = input.sports.map((sport, index) => {
            const key = `sport${index}`;
            values[key] = sport;
            return `lower($${key})`;
          });
          clauses.push(`lower(activity.sport) IN (${placeholders.join(', ')})`);
        }
        const rows = await repository.rows<{ activity_source_id: string }>(`
          SELECT source.activity_source_id
          FROM activity_sources AS source JOIN activities AS activity USING (activity_id)
          WHERE ${clauses.join(' AND ')}
          ORDER BY activity.started_at_utc DESC, source.activity_source_id ASC
          LIMIT $limit
        `, values);
        return rows.map((row) => row.activity_source_id);
      });
    const outcomes: Array<Record<string, unknown>> = [];
    let haltedBy: string | null = null;
    for (const activityId of activityIds) {
      if (haltedBy) {
        outcomes.push({ activityId, status: 'skipped', reason: haltedBy });
        continue;
      }
      try {
        const result = await hydrateStravaActivity(activePaths(), activityId, input.refresh ?? false);
        const status = typeof result.status === 'string' ? result.status : 'completed';
        outcomes.push({ activityId, status, result });
      } catch (error) {
        const failure = hydrationFailure(error);
        outcomes.push({ activityId, status: 'failed', error: failure });
        if (failure.code === 'rate_limited' || failure.code === 'data_sync_in_progress') haltedBy = failure.message;
      }
    }
    const summary = outcomes.reduce<Record<string, number>>((counts, outcome) => {
      const status = String(outcome.status);
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    return {
      data: { activityIds, outcomes, summary },
      provenance: { provider: 'strava', operation: 'serial_activity_hydration', archivedBeforeNormalization: true },
      query: { ...input, activityIds },
      caveats: ['Each write is intentionally awaited before the next one, preventing data-directory lock contention.', 'not_found and ambiguous results include match diagnostics when Strava supplied them.'],
    };
  }));

  server.registerTool('hydrate_strava_segment_history', {
    title: 'Hydrate one Strava segment history',
    description: 'Write-only targeted enrichment. Fetches a persisted Strava segment and the authenticated athlete’s paged historic efforts; interrupted or throttled work is resumable.',
    inputSchema: { segmentId: z.string().min(1), refresh: z.boolean().optional() },
  }, tool('hydrate_strava_segment_history', async (input) => {
    const data = await hydrateStravaSegmentHistory(activePaths(), input.segmentId, input.refresh ?? false);
    return { data, coverage: await useRepository(activePaths(), (repository) => repository.coverage()), provenance: { provider: 'strava', operation: 'segment_effort_history', archivedBeforeNormalization: true }, caveats: ['Only the authenticated athlete’s historic segment efforts are requested.'] };
  }));

  if (catalogPaths) {
    server.registerResource('athletes', 'catence://athletes', { title: 'Configured athlete roster', mimeType: 'application/json' }, async (uri) => {
      try { const catalog = await loadCatalog(catalogPaths); return resource(uri, { defaultAthleteId: catalog.defaultAthleteId, athletes: catalog.athletes }); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
    });
  } else {
    server.registerResource('status', 'catence://status', { title: 'Catence status', mimeType: 'application/json' }, async (uri) => {
      const limited = await resourceLimit('status', uri); if (limited) return limited;
      try { return resource(uri, await useRepository(activePaths(), (repository) => repository.status())); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
    });
    server.registerResource('catalog', 'catence://catalog', { title: 'Catence catalog', mimeType: 'application/json' }, async (uri) => { const limited = await resourceLimit('catalog', uri); if (limited) return limited; return resource(uri, { datasets: Object.values(DATASET_CATALOG) }); });
    server.registerResource('activity', new ResourceTemplate('catence://activity/{activityId}', { list: undefined }), { title: 'Activity detail', mimeType: 'application/json' }, async (uri, variables) => {
      const limited = await resourceLimit('activity', uri); if (limited) return limited;
      try { return resource(uri, await useRepository(activePaths(), (repository) => repository.activity(variable(variables.activityId)))); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
    });
    server.registerResource('summary', new ResourceTemplate('catence://summary/{startDate}/{endDate}', { list: undefined }), { title: 'Catence date-range summary', mimeType: 'application/json' }, async (uri, variables) => {
      const limited = await resourceLimit('summary', uri); if (limited) return limited;
      try { return resource(uri, await useRepository(activePaths(), (repository) => repository.summary(variable(variables.startDate), variable(variables.endDate)))); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
    });
  }
  return server;
}

function variable(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw new QueryValidationError('A required resource URI variable is missing.');
}
