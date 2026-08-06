import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configuredMcpRateLimit, loadCatenceConfig, resolvePaths, type CatencePaths } from '../../core/runtime/configuration.js';
import { SlidingWindowLimiter } from '../../core/runtime/limiter.js';
import { DataWriteBusyError } from '../../elt/storage/write-lock.js';
import { hydrateStravaActivity, hydrateStravaSegmentHistory, StravaEnrichmentError, StravaRateLimitError } from '../../elt/ingestion/providers/strava/service.js';
import { openReadOnlyRepository, ReadOnlyDatabaseError } from '../../elt/storage/database.js';
import { searchContext } from '../../core/retrieval/index.js';
import { AnalyticsService, type DataFilter } from '../../core/query/analytics.js';
import { ActivityDiscoveryService } from '../../core/query/activity-discovery.js';
import { getDataset, QueryValidationError } from '../../core/query/catalog.js';
import { FitnessService } from '../../core/query/fitness.js';
import { jsonSafe, ReadOnlyRepository } from '../../core/query/repository.js';
import { queryReadOnlyData } from '../../core/query/sql-guard.js';

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

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(jsonSafe(value), null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  const classified = error instanceof DataWriteBusyError
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

export function createCatenceMcpServer(paths = resolvePaths()): McpServer {
  const server = new McpServer({ name: 'catence', version: '0.1.0' });
  const configPromise = loadCatenceConfig(paths);
  const limiter = new SlidingWindowLimiter();
  const tool = <T>(name: string, fn: (input: T) => Promise<unknown>) => async (input: T): Promise<ToolResult> => {
    try {
      const config = await configPromise;
      const decision = limiter.check(`tool:${name}`, configuredMcpRateLimit(config, 'tools', name));
      if (!decision.allowed) return { ...textResult({ data: null, error: { code: 'rate_limited', message: `MCP tool ${name} is locally rate limited.`, retryAfterSeconds: decision.retryAfterSeconds } }), isError: true };
      return textResult(await fn(input));
    } catch (error) { return errorResult(error); }
  };
  const resourceLimit = async (name: string, uri: URL) => {
    try {
      const config = await configPromise;
      const decision = limiter.check(`resource:${name}`, configuredMcpRateLimit(config, 'resources', name));
      if (!decision.allowed) return resource(uri, { error: { code: 'rate_limited', message: `MCP resource ${name} is locally rate limited.`, retryAfterSeconds: decision.retryAfterSeconds } });
      return null;
    } catch (error) { return resource(uri, { error: JSON.parse(errorResult(error).content[0]!.text) }); }
  };

  server.registerTool('catence_status', {
    title: 'Catence data status',
    description: 'Read sync state, data coverage, entity counts, stream availability, unresolved errors, and retrieval-index freshness. Read-only.',
  }, tool('catence_status', async () => useRepository(paths, async (repository) => ({
    data: { ...(await repository.status()), ...(await repository.coverage()) },
    provenance: { database: 'read-only DuckDB snapshot' }, query: {}, caveats: [],
  }))));

  server.registerTool('describe_data', {
    title: 'Describe available Catence datasets',
    description: 'List cataloged datasets, fields, units, permitted filters/groupings, providers, and time coverage. Read-only.',
  }, tool('describe_data', async () => useRepository(paths, async (repository) => ({
    data: { datasets: repository.catalog(), ...(await repository.coverage()) },
    provenance: { catalog: 'Catence catalog, restricted to analytical views' }, query: {}, caveats: ['activity_samples is available only through read_series or aggregate_data and only reads registered Parquet stream manifests.'],
  }))));

  server.registerTool('describe_dataset', {
    title: 'Describe one Catence dataset',
    description: 'Read a compact schema, permitted filters/groupings, provenance fields, and coverage for one cataloged dataset. Read-only.',
    inputSchema: { dataset: z.string().min(1) },
  }, tool('describe_dataset', async (input) => useRepository(paths, async (repository) => {
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
    title: 'Read a bounded time series', description: 'Read cataloged numeric series with deterministic cursor pagination and automatic stream downsampling.', inputSchema: seriesInput,
  }, tool('read_series', async (input) => useRepository(paths, (repository) => new AnalyticsService(repository).readSeries({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('aggregate_data', {
    title: 'Aggregate cataloged data', description: 'Declarative aggregation over one cataloged dataset. No joins, arbitrary expressions, or file paths.',
    inputSchema: {
      dataset: z.string().min(1),
      metrics: z.array(z.object({ column: z.string().min(1), operation: z.enum(['count', 'sum', 'mean', 'min', 'max', 'percentile']), percentile: z.number().gt(0).lt(1).optional(), as: z.string().min(1).max(64).optional() })).min(1).max(12),
      dimensions: z.array(z.string().min(1)).max(8).optional(), filters: z.array(filterSchema).max(50).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), timeBucket: z.enum(['day', 'week', 'month']).optional(), orderBy: z.object({ column: z.string().min(1), direction: z.enum(['asc', 'desc']).optional() }).optional(), limit: z.number().int().min(1).max(500).optional(),
    },
  }, tool('aggregate_data', async (input) => useRepository(paths, (repository) => new AnalyticsService(repository).aggregate({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('analyze_series', {
    title: 'Analyze a descriptive series', description: 'Run deterministic rolling statistics, baselines, correlations, seasonal comparisons, or trends on a cataloged series.',
    inputSchema: { ...seriesInput, analysis: z.enum(['rolling_mean', 'rolling_median', 'baseline_change', 'z_score', 'pearson', 'spearman', 'seasonal_comparison', 'linear_trend', 'theil_sen_trend']), compareMetric: z.string().min(1).optional(), window: z.number().int().min(2).max(100).optional() },
  }, tool('analyze_series', async (input) => useRepository(paths, (repository) => new AnalyticsService(repository).analyzeSeries({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('fit_series_model', {
    title: 'Fit a descriptive series model', description: 'Fit a bounded OLS, Theil–Sen, quadratic, or cubic descriptive model. Not a sport-performance model.',
    inputSchema: { ...seriesInput, model: z.enum(['ols_linear', 'theil_sen_linear', 'polynomial_2', 'polynomial_3']), xMetric: z.string().min(1).optional(), yMetric: z.string().min(1).optional() },
  }, tool('fit_series_model', async (input) => useRepository(paths, (repository) => new AnalyticsService(repository).fitSeriesModel({ ...input, filters: input.filters as DataFilter[] | undefined }))));

  server.registerTool('get_ftp_history', {
    title: 'Get dated FTP history',
    description: 'Return normalized cycling FTP settings and activity-summary observations with source-aware preferred daily values. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), sourcePreference: z.enum(['settings', 'settings_then_activity', 'all']).optional() },
  }, tool('get_ftp_history', async (input) => useRepository(paths, (repository) => new FitnessService(repository).ftpHistory(input))));

  server.registerTool('get_vo2max_history', {
    title: 'Get sport-specific VO₂max history',
    description: 'Return normalized Garmin VO₂max observations for exactly one sport; generic and cycling values remain separate. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional() },
  }, tool('get_vo2max_history', async (input) => useRepository(paths, (repository) => new FitnessService(repository).vo2MaxHistory(input))));

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
  }, tool('find_activities', async (input) => useRepository(paths, (repository) => new ActivityDiscoveryService(repository).findActivities(input))));

  server.registerTool('power_curve_trend', {
    title: 'Read labelled power-curve trends',
    description: 'Return monthly bests for selected power durations, including the supporting activity and source type. Read-only.',
    inputSchema: { sport: z.string().min(1).optional(), durations: z.array(z.number().int().min(1).max(86_400)).min(1).max(12).optional(), startDate: z.string().date().optional(), endDate: z.string().date().optional(), sourceQuality: z.enum(['all', 'garmin_fit_derived']).optional() },
  }, tool('power_curve_trend', async (input) => useRepository(paths, (repository) => new FitnessService(repository).powerCurveTrend(input))));

  server.registerTool('latest_cycling_activities', {
    title: 'List latest cycling activities',
    description: 'List Garmin cycling source records without duplicate Intervals summaries, optionally flagging multisport parent records. Read-only.',
    inputSchema: { startDate: z.string().date().optional(), endDate: z.string().date().optional(), includeMultisport: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, tool('latest_cycling_activities', async (input) => useRepository(paths, (repository) => new FitnessService(repository).latestCyclingActivities(input))));

  server.registerTool('cycling_progress_report', {
    title: 'Build a cycling progress report',
    description: 'Combine source-aware FTP and VO₂max histories with monthly canonical volume/load and labelled power-curve trends. Read-only and descriptive.',
    inputSchema: { startDate: z.string().date().optional(), endDate: z.string().date().optional() },
  }, tool('cycling_progress_report', async (input) => useRepository(paths, (repository) => new FitnessService(repository).cyclingProgressReport(input))));

  server.registerTool('query_read_only_data', {
    title: 'Query cataloged read-only data', description: 'Advanced fallback: one parameterized SELECT or WITH … SELECT over cataloged views only. Results use deterministic cursor pagination and always report whether they are incomplete. Filesystem access, extensions, DDL, and mutation are rejected.',
    inputSchema: { sql: z.string().min(1).max(20_000), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).refine((value) => Object.keys(value).length <= 100, 'At most 100 bind values are allowed.').optional(), cursor: z.string().min(1).optional(), pageSize: z.number().int().min(1).max(500).optional() },
  }, tool('query_read_only_data', async (input) => useRepository(paths, (repository) => queryReadOnlyData(repository, input))));

  server.registerTool('search_context', {
    title: 'Search generated context', description: 'Search compact generated activity, plan, nutrition, and message context. Results identify authoritative follow-up tools rather than making numerical claims.',
    inputSchema: { query: z.string().min(2).max(500), filters: z.array(z.object({ column: z.enum(['provider', 'entity_type', 'occurred_on']), op: z.enum(['eq', 'in', 'between']), value: z.unknown() })).max(20).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, tool('search_context', async (input) => useRepository(paths, (repository) => searchContext(repository, input))));

  server.registerTool('hydrate_strava_activity', {
    title: 'Hydrate one activity from Strava',
    description: 'Write-only targeted enrichment. Safely matches exactly one Catence activity/source to Strava, then archives and persists its activity detail, gear assignment, and segment efforts.',
    inputSchema: { activityId: z.string().min(1), refresh: z.boolean().optional() },
  }, tool('hydrate_strava_activity', async (input) => {
    const data = await hydrateStravaActivity(paths, input.activityId, input.refresh ?? false);
    return { data, coverage: await useRepository(paths, (repository) => repository.coverage()), provenance: { provider: 'strava', operation: 'activity_detail', archivedBeforeNormalization: true }, caveats: ['Segment verification is unavailable from Strava public segment data and is never inferred.'] };
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
      : await useRepository(paths, async (repository) => {
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
        const result = await hydrateStravaActivity(paths, activityId, input.refresh ?? false);
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
    const data = await hydrateStravaSegmentHistory(paths, input.segmentId, input.refresh ?? false);
    return { data, coverage: await useRepository(paths, (repository) => repository.coverage()), provenance: { provider: 'strava', operation: 'segment_effort_history', archivedBeforeNormalization: true }, caveats: ['Only the authenticated athlete’s historic segment efforts are requested.'] };
  }));

  server.registerResource('status', 'catence://status', { title: 'Catence status', mimeType: 'application/json' }, async (uri) => {
    const limited = await resourceLimit('status', uri); if (limited) return limited;
    try { return resource(uri, await useRepository(paths, (repository) => repository.status())); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
  });
  server.registerResource('catalog', 'catence://catalog', { title: 'Catence catalog', mimeType: 'application/json' }, async (uri) => { const limited = await resourceLimit('catalog', uri); if (limited) return limited; return resource(uri, { datasets: Object.values((await import('../../core/query/catalog.js')).DATASET_CATALOG) }); });
  server.registerResource('activity', new ResourceTemplate('catence://activity/{activityId}', { list: undefined }), { title: 'Activity detail', mimeType: 'application/json' }, async (uri, variables) => {
    const limited = await resourceLimit('activity', uri); if (limited) return limited;
    try { return resource(uri, await useRepository(paths, (repository) => repository.activity(variable(variables.activityId)))); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
  });
  server.registerResource('summary', new ResourceTemplate('catence://summary/{startDate}/{endDate}', { list: undefined }), { title: 'Catence date-range summary', mimeType: 'application/json' }, async (uri, variables) => {
    const limited = await resourceLimit('summary', uri); if (limited) return limited;
    try { return resource(uri, await useRepository(paths, (repository) => repository.summary(variable(variables.startDate), variable(variables.endDate)))); } catch (error) { return resource(uri, { error: errorResult(error).content[0].text }); }
  });
  return server;
}

function variable(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw new QueryValidationError('A required resource URI variable is missing.');
}
