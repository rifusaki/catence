import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configuredMcpRateLimit, loadCatenceConfig, resolvePaths, type CatencePaths } from '../../core/runtime/configuration.js';
import { SlidingWindowLimiter } from '../../core/runtime/limiter.js';
import { DataWriteBusyError } from '../../elt/storage/write-lock.js';
import { hydrateStravaActivity, hydrateStravaSegmentHistory, StravaEnrichmentError, StravaRateLimitError } from '../../elt/ingestion/providers/strava/service.js';
import { openReadOnlyRepository, ReadOnlyDatabaseError } from '../../elt/storage/database.js';
import { searchContext } from '../../core/retrieval/index.js';
import { AnalyticsService, type DataFilter } from '../../core/query/analytics.js';
import { QueryValidationError } from '../../core/query/catalog.js';
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

  server.registerTool('query_read_only_data', {
    title: 'Query cataloged read-only data', description: 'Advanced fallback: one parameterized SELECT or WITH … SELECT over cataloged views only. Filesystem access, extensions, DDL, and mutation are rejected.',
    inputSchema: { sql: z.string().min(1).max(20_000), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).refine((value) => Object.keys(value).length <= 100, 'At most 100 bind values are allowed.').optional() },
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
