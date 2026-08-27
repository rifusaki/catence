import { createHash } from 'node:crypto';
import type { QueryValues } from '../../contracts/storage.js';
import { getColumn, getDataset, QueryValidationError, type CatalogColumn, type DatasetDefinition } from './catalog.js';
import { jsonSafe, ReadOnlyRepository } from './repository.js';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between' | 'contains';
export type DataFilter = { column: string; op: FilterOperator; value: unknown };
export type Resolution = 'raw' | '1m' | '5m' | '15m' | '1h' | 'day' | 'week' | 'auto';
export type SeriesRequest = {
  dataset: string;
  metrics: string[];
  filters?: DataFilter[];
  startDate?: string;
  endDate?: string;
  activityId?: string;
  resolution?: Resolution;
  cursor?: string;
  pageSize?: number;
};

export type DeriveDecouplingRequest = {
  activityId: string;
};

export type DeriveGapRequest = {
  activityId: string;
};

const resolutionIntervals: Record<Exclude<Resolution, 'raw' | 'auto'>, string> = {
  '1m': 'minute', '5m': 'minute', '15m': 'minute', '1h': 'hour', day: 'day', week: 'week',
};

// Decoupling / GAP thresholds — kept conservative so short or walk-heavy efforts
// are reported as insufficient rather than silently producing a misleading drift.
const MIN_TOTAL_SAMPLES = 300;
const MIN_MOVING_SAMPLES = 360;
const MIN_VALID_SAMPLES = 360;
const MOVING_RATIO_THRESHOLD = 0.55;
const HR_COVERAGE_THRESHOLD = 0.6;
const METRIC_COVERAGE_THRESHOLD = 0.6;
const WALK_SPEED_THRESHOLD_MPS = 2.0;
const CYCLING_MOVING_SPEED_THRESHOLD_MPS = 1.0;
const RUNNING_MOVING_SPEED_THRESHOLD_MPS = 0.8;
const MIN_MOVING_DURATION_S = 600;
const GRADE_CLAMP = 0.3;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function valuesRecord(values: QueryValues, key: string, value: unknown): void {
  values[key] = value;
}

function compileFilter(dataset: DatasetDefinition, filter: DataFilter, index: number, values: QueryValues): string {
  const column = getColumn(dataset, filter.column);
  if (!column.filterable) throw new QueryValidationError(`${filter.column} cannot be used as a filter on ${dataset.name}.`);
  const sqlColumn = quoteIdentifier(column.name);
  const key = `filter${index}`;
  if (filter.op === 'eq' || filter.op === 'neq') {
    if (filter.value === null) return `${sqlColumn} IS ${filter.op === 'eq' ? '' : 'NOT '}NULL`;
    valuesRecord(values, key, filter.value);
    return `${sqlColumn} ${filter.op === 'eq' ? '=' : '<>'} $${key}`;
  }
  if (filter.op === 'gt' || filter.op === 'gte' || filter.op === 'lt' || filter.op === 'lte') {
    valuesRecord(values, key, filter.value);
    return `${sqlColumn} ${({ gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[filter.op]} $${key}`;
  }
  if (filter.op === 'contains') {
    if (typeof filter.value !== 'string') throw new QueryValidationError('contains filters require a string value.');
    valuesRecord(values, key, filter.value);
    return `${sqlColumn} ILIKE '%' || $${key} || '%'`;
  }
  if (filter.op === 'in') {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) throw new QueryValidationError('in filters require 1–100 values.');
    const placeholders = filter.value.map((item, itemIndex) => {
      const itemKey = `${key}_${itemIndex}`;
      valuesRecord(values, itemKey, item);
      return `$${itemKey}`;
    });
    return `${sqlColumn} IN (${placeholders.join(', ')})`;
  }
  if (filter.op === 'between') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new QueryValidationError('between filters require exactly two values.');
    valuesRecord(values, `${key}_start`, filter.value[0]);
    valuesRecord(values, `${key}_end`, filter.value[1]);
    return `${sqlColumn} BETWEEN $${key}_start AND $${key}_end`;
  }
  throw new QueryValidationError(`Unsupported filter operator: ${filter.op}`);
}

export function compileFilters(dataset: DatasetDefinition, filters: DataFilter[] = [], startDate?: string, endDate?: string, activityId?: string): { where: string; values: QueryValues } {
  const values: QueryValues = {};
  const clauses = filters.map((filter, index) => compileFilter(dataset, filter, index, values));
  if ((startDate || endDate) && !dataset.dateColumn) throw new QueryValidationError(`${dataset.name} has no date column; scope it using an ID filter.`);
  if (startDate) {
    values.startDate = startDate;
    clauses.push(`${quoteIdentifier(dataset.dateColumn!)} >= cast($startDate AS ${dataset.dateColumn === 'metric_date' || dataset.dateColumn === 'nutrition_date' || dataset.dateColumn === 'occurred_on' ? 'DATE' : 'TIMESTAMPTZ'})`);
  }
  if (endDate) {
    values.endDate = dataset.dateColumn === 'metric_date' || dataset.dateColumn === 'nutrition_date' || dataset.dateColumn === 'occurred_on' ? endDate : `${endDate}T23:59:59.999Z`;
    clauses.push(`${quoteIdentifier(dataset.dateColumn!)} <= cast($endDate AS ${dataset.dateColumn === 'metric_date' || dataset.dateColumn === 'nutrition_date' || dataset.dateColumn === 'occurred_on' ? 'DATE' : 'TIMESTAMPTZ'})`);
  }
  if (activityId) {
    const activityColumn = dataset.columns.find((column) => column.name === 'activity_id');
    if (!activityColumn) throw new QueryValidationError(`${dataset.name} cannot be scoped by logical activity ID.`);
    values.activityId = activityId;
    clauses.push('"activity_id" = $activityId');
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

type Cursor = { hash: string; offset: number; resolution: Resolution };
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
function decodeCursor(cursor: string, expectedHash: string): Cursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.hash !== expectedHash || !decoded.resolution) throw new Error();
    return decoded;
  } catch {
    throw new QueryValidationError('Invalid or mismatched cursor. Start the series query again.');
  }
}

function queryHash(request: Omit<SeriesRequest, 'cursor' | 'pageSize'>): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('base64url');
}

function isNumeric(column: CatalogColumn): boolean {
  return column.metric === true;
}

function isTemporal(column: CatalogColumn): boolean {
  return /(?:^|\s)(?:DATE|TIME|TIMESTAMP)/i.test(column.type);
}

function timestampExpression(dataset: DatasetDefinition): string {
  if (!dataset.dateColumn) throw new QueryValidationError(`${dataset.name} has no time axis.`);
  return quoteIdentifier(dataset.dateColumn);
}

function bucketExpression(timestamp: string, resolution: Resolution): string {
  if (resolution === 'day' || resolution === 'week' || resolution === '1h') return `date_trunc('${resolutionIntervals[resolution]}', ${timestamp})`;
  if (resolution === '1m') return `date_trunc('minute', ${timestamp})`;
  if (resolution === '5m' || resolution === '15m') {
    const seconds = resolution === '5m' ? 300 : 900;
    return `to_timestamp(floor(epoch(${timestamp}) / ${seconds}) * ${seconds})`;
  }
  throw new QueryValidationError(`Cannot bucket with ${resolution}.`);
}

function sourceRelation(relation: string): string {
  return relation.trimStart().toLowerCase().startsWith('select') ? `(${relation})` : quoteIdentifier(relation);
}

function isCyclingSport(sport: string | null): boolean {
  if (!sport) return false;
  const normalized = sport.toLowerCase();
  return normalized.includes('cycl') || normalized.includes('bik') || normalized.includes('ride') || normalized === 'virtual_ride';
}

function isRunningSport(sport: string | null): boolean {
  if (!sport) return false;
  const normalized = sport.toLowerCase();
  return normalized.includes('run') || normalized.includes('trail');
}

function clampGrade(grade: number): number {
  if (grade > GRADE_CLAMP) return GRADE_CLAMP;
  if (grade < -GRADE_CLAMP) return -GRADE_CLAMP;
  return grade;
}

// Minetti et al. 2002 energy cost of running (J/kg/m). grade is rise/run as a
// fraction (0.10 = 10 %). The polynomial reproduces the U-shaped cost curve:
// cheaper slightly downhill, markedly more expensive uphill and very steep downhill.
function runningCost(gradeFraction: number): number {
  const g = clampGrade(gradeFraction);
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

type ActivitySourceIdentity = {
  activity_source_id: string;
  provider: string;
  sport: string | null;
  activity_id: string;
  started_at_utc: string | null;
};

type SampleRow = {
  timestamp_utc: string | null;
  elapsed_s: number | null;
  distance_m: number | null;
  altitude_m: number | null;
  heart_rate_bpm: number | null;
  power_w: number | null;
  speed_mps: number | null;
  grade_pct: number | null;
};

export class AnalyticsService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async readSeries(request: SeriesRequest): Promise<Record<string, unknown>> {
    const dataset = getDataset(request.dataset);
    const metrics = [...new Set(request.metrics)];
    if (metrics.length === 0 || metrics.length > 12) throw new QueryValidationError('read_series requires 1–12 metrics.');
    for (const metric of metrics) {
      const column = getColumn(dataset, metric);
      if (!isNumeric(column)) throw new QueryValidationError(`${metric} is not a numeric metric in ${dataset.name}.`);
    }
    const requestedResolution = request.resolution ?? 'auto';
    // MCP validates a 1,000-point public page. Internal model fitting can use
    // the documented 5,000-point cap without changing the public tool limit.
    const pageSize = Math.min(Math.max(request.pageSize ?? 1_000, 1), 5_000);
    const { cursor: ignoredCursor, pageSize: ignoredPageSize, ...fingerprintRequest } = request;
    void ignoredCursor;
    void ignoredPageSize;
    const fingerprint = queryHash(fingerprintRequest);
    const cursor = request.cursor ? decodeCursor(request.cursor, fingerprint) : undefined;
    let resolution: Resolution = cursor?.resolution ?? requestedResolution;
    const relation = await this.repository.datasetRelation(dataset.name);
    const source = sourceRelation(relation);
    const { where, values } = compileFilters(dataset, request.filters, request.startDate, request.endDate, request.activityId);
    if (dataset.name === 'activity_samples' && !request.startDate && !request.endDate && !request.activityId && !request.filters?.some((filter) => filter.column === 'activity_source_id')) {
      throw new QueryValidationError('activity_samples requires a date scope or activity_source_id filter.');
    }
    const date = timestampExpression(dataset);
    const rawSelect = `${date} AS timestamp, ${metrics.map(quoteIdentifier).join(', ')}, ${dataset.provenanceColumns.filter((column) => dataset.columns.some((known) => known.name === column)).map(quoteIdentifier).join(', ')}`;
    const order = `${date} ASC, ${dataset.provenanceColumns[0] ? quoteIdentifier(dataset.provenanceColumns[0]) : '1'} ASC`;
    let rawTotalRows: number | undefined;
    if (resolution === 'auto') {
      const probe = await this.repository.rows(`SELECT count(*)::BIGINT AS row_count FROM ${source} AS source ${where}`, values);
      const rowCount = Number(probe[0]?.row_count ?? 0);
      rawTotalRows = rowCount;
      resolution = rowCount > pageSize
        ? dataset.name === 'activity_samples' ? '1m'
          : ['daily_metrics', 'daily_health', 'nutrition_days', 'nutrition_items'].includes(dataset.name) ? 'week'
            : 'day'
        : 'raw';
    }
    const offset = cursor?.offset ?? 0;
    let totalRows: number;
    if (resolution === 'raw') {
      if (rawTotalRows === undefined) {
        const total = await this.repository.rows<{ total_rows: number | bigint }>(`SELECT count(*) AS total_rows FROM ${source} AS source ${where}`, values);
        rawTotalRows = Number(total[0]?.total_rows ?? 0);
      }
      totalRows = rawTotalRows;
    } else {
      const bucket = bucketExpression(date, resolution);
      const provenance = dataset.provenanceColumns.filter((column) => dataset.columns.some((known) => known.name === column));
      const total = await this.repository.rows<{ total_rows: number | bigint }>(`
        SELECT count(*) AS total_rows FROM (
          SELECT ${bucket} AS timestamp
          FROM ${source} AS source ${where}
          GROUP BY ${bucket}, ${provenance.map(quoteIdentifier).join(', ')}
        ) AS series_total
      `, values);
      totalRows = Number(total[0]?.total_rows ?? 0);
    }
    values.limit = pageSize + 1;
    values.offset = offset;
    let rows: Record<string, unknown>[];
    if (resolution === 'raw') {
      rows = await this.repository.rows(`SELECT ${rawSelect} FROM ${source} AS source ${where} ORDER BY ${order} LIMIT $limit OFFSET $offset`, values);
    } else {
      const bucket = bucketExpression(date, resolution);
      const provenance = dataset.provenanceColumns.filter((column) => dataset.columns.some((known) => known.name === column));
      rows = await this.repository.rows(`
        SELECT ${bucket} AS timestamp, ${metrics.map((metric) => `avg(${quoteIdentifier(metric)}) AS ${quoteIdentifier(metric)}`).join(', ')}, ${provenance.map(quoteIdentifier).join(', ')}
        FROM ${source} AS source ${where}
        GROUP BY ${bucket}, ${provenance.map(quoteIdentifier).join(', ')}
        ORDER BY timestamp ASC${provenance.length ? `, ${provenance.map(quoteIdentifier).join(', ')}` : ''}
        LIMIT $limit OFFSET $offset
      `, values);
    }
    const hasMore = rows.length > pageSize;
    if (hasMore) rows.pop();
    const returnedRows = rows.length;
    const truncated = offset + returnedRows < totalRows;
    return jsonSafe({
      returnedRows,
      totalRows,
      truncated,
      nextCursor: truncated ? encodeCursor({ hash: fingerprint, offset: offset + returnedRows, resolution }) : undefined,
      data: rows,
      provenance: { dataset: dataset.name, source: dataset.relation ?? 'registered stream_manifest Parquet only', columns: dataset.provenanceColumns },
      query: { dataset: dataset.name, metrics, filters: request.filters ?? [], startDate: request.startDate, endDate: request.endDate, activityId: request.activityId, requestedResolution, resolution, pageSize },
      caveats: [
        ...(resolution !== requestedResolution && requestedResolution === 'auto' ? ['Automatically downsampled to stay within the first response page. Use the returned cursor for later pages.'] : []),
        ...(truncated ? ['Results are incomplete. Do not draw exhaustive conclusions; retrieve remaining pages with nextCursor or narrow the query.'] : []),
      ],
    });
  }

  async aggregate(request: { dataset: string; metrics: Array<{ column: string; operation: 'count' | 'sum' | 'mean' | 'min' | 'max' | 'percentile'; percentile?: number; as?: string }>; dimensions?: string[]; filters?: DataFilter[]; startDate?: string; endDate?: string; timeBucket?: 'day' | 'week' | 'month'; orderBy?: { column: string; direction?: 'asc' | 'desc' }; limit?: number }): Promise<Record<string, unknown>> {
    const dataset = getDataset(request.dataset);
    if (dataset.samplesOnly && !request.filters?.some((filter) => filter.column === 'activity_source_id')) throw new QueryValidationError('activity_samples aggregation requires an activity_source_id filter.');
    if (request.metrics.length === 0 || request.metrics.length > 12) throw new QueryValidationError('aggregate_data requires 1–12 aggregations.');
    const relation = await this.repository.datasetRelation(dataset.name);
    const source = sourceRelation(relation);
    const { where, values } = compileFilters(dataset, request.filters, request.startDate, request.endDate);
    const dimensions = [...new Set(request.dimensions ?? [])];
    for (const dimension of dimensions) {
      const column = getColumn(dataset, dimension);
      if (!column.groupable) throw new QueryValidationError(`${dimension} is not a permitted grouping.`);
    }
    const groups: string[] = dimensions.map(quoteIdentifier);
    const selections: string[] = [...groups];
    if (request.timeBucket) {
      if (!dataset.dateColumn) throw new QueryValidationError(`${dataset.name} cannot be time-bucketed.`);
      const bucket = `date_trunc('${request.timeBucket}', ${timestampExpression(dataset)})`;
      selections.unshift(`${bucket} AS time_bucket`);
      groups.unshift(bucket);
    }
    for (const [index, metric] of request.metrics.entries()) {
      const column = getColumn(dataset, metric.column);
      // A timestamp has no meaningful sum/mean/percentile, but its extrema are
      // both safe and useful (for example, first/last observation dates).
      if (metric.operation !== 'count' && !isNumeric(column) && !((metric.operation === 'min' || metric.operation === 'max') && isTemporal(column))) {
        throw new QueryValidationError(`${metric.column} is not numeric; only min and max support temporal columns.`);
      }
      const outputName = metric.as ?? `${metric.operation}_${metric.column}`;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(outputName)) throw new QueryValidationError('Aggregation aliases must be simple identifiers.');
      if (metric.operation === 'percentile') {
        const percentile = metric.percentile ?? 0.5;
        if (!(percentile > 0 && percentile < 1)) throw new QueryValidationError('percentile must be between 0 and 1.');
        values[`percentile${index}`] = percentile;
        selections.push(`quantile_cont(${quoteIdentifier(metric.column)}, $percentile${index}) AS ${quoteIdentifier(outputName)}`);
      } else if (metric.operation === 'count') selections.push(`count(${quoteIdentifier(metric.column)}) AS ${quoteIdentifier(outputName)}`);
      else selections.push(`${({ sum: 'sum', mean: 'avg', min: 'min', max: 'max' } as const)[metric.operation]}(${quoteIdentifier(metric.column)}) AS ${quoteIdentifier(outputName)}`);
    }
    // ``timeBucket`` produces the public ``time_bucket`` field. Keep ``bucket``
    // as an ordering-only compatibility alias for calls made before that name
    // was standardized.
    const requestedOrderBy = request.orderBy?.column;
    const orderBy = requestedOrderBy === 'bucket' && request.timeBucket ? 'time_bucket' : requestedOrderBy;
    const aliases = selections.map((selection) => selection.match(/AS "?([A-Za-z_][A-Za-z0-9_]*)"?$/i)?.[1]).filter(Boolean) as string[];
    if (orderBy && !aliases.includes(orderBy) && !dimensions.includes(orderBy)) throw new QueryValidationError('orderBy must name a selected dimension, time_bucket, or aggregation alias.');
    values.limit = Math.min(Math.max(request.limit ?? 100, 1), 500);
    const rows = await this.repository.rows(`SELECT ${selections.join(', ')} FROM ${source} AS source ${where}${groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}${orderBy ? ` ORDER BY ${quoteIdentifier(orderBy)} ${request.orderBy?.direction === 'asc' ? 'ASC' : 'DESC'}` : ''} LIMIT $limit`, values);
    return jsonSafe({ data: rows, provenance: { dataset: dataset.name, columns: dataset.provenanceColumns }, query: request, caveats: [] });
  }

  async analyzeSeries(request: SeriesRequest & { analysis: 'rolling_mean' | 'rolling_median' | 'baseline_change' | 'z_score' | 'pearson' | 'spearman' | 'seasonal_comparison' | 'linear_trend' | 'theil_sen_trend'; compareMetric?: string; window?: number }): Promise<Record<string, unknown>> {
    const compareMetric = request.compareMetric ?? request.metrics[1];
    const series = await this.readSeries({ ...request, metrics: [...new Set([request.metrics[0], ...(compareMetric ? [compareMetric] : [])])], resolution: request.resolution ?? 'auto', pageSize: 1_000 });
    const rows = series.data as Array<Record<string, unknown>>;
    const primary = request.metrics[0];
    const values = rows.map((row) => numberOrNull(row[primary]));
    const finite = values.filter((value): value is number => value !== null);
    if (finite.length < 3) throw new QueryValidationError('At least three non-null observations are required for analysis.');
    const analysis = request.analysis;
    let result: Record<string, unknown>;
    if (analysis === 'rolling_mean' || analysis === 'rolling_median') {
      const window = Math.min(Math.max(request.window ?? 7, 2), 100);
      result = { window, values: rolling(values, window, analysis === 'rolling_mean' ? mean : median) };
    } else if (analysis === 'baseline_change') {
      const baseline = mean(finite.slice(0, Math.max(1, Math.floor(finite.length / 3))));
      const recent = mean(finite.slice(-Math.max(1, Math.floor(finite.length / 3))));
      result = { baseline, recent, absoluteChange: recent - baseline, percentChange: baseline === 0 ? null : ((recent - baseline) / Math.abs(baseline)) * 100 };
    } else if (analysis === 'z_score') {
      const center = mean(finite); const deviation = standardDeviation(finite);
      result = { mean: center, standardDeviation: deviation, values: values.map((value) => value === null || deviation === 0 ? null : (value - center) / deviation) };
    } else if (analysis === 'pearson' || analysis === 'spearman') {
      const compare = compareMetric;
      if (!compare) throw new QueryValidationError('Correlation requires compareMetric or a second metric.');
      const pairs = rows.map((row) => [numberOrNull(row[primary]), numberOrNull(row[compare])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null);
      if (pairs.length < 3) throw new QueryValidationError('At least three paired values are required for correlation.');
      const [x, y] = pairs.reduce<[number[], number[]]>((accumulator, pair) => { accumulator[0].push(pair[0]); accumulator[1].push(pair[1]); return accumulator; }, [[], []]);
      result = { compareMetric: compare, correlation: pearson(analysis === 'spearman' ? ranks(x) : x, analysis === 'spearman' ? ranks(y) : y), pairedCount: pairs.length, method: analysis };
    } else if (analysis === 'seasonal_comparison') {
      const byMonth = new Map<string, number[]>();
      rows.forEach((row, index) => {
        if (values[index] === null || !row.timestamp) return;
        const month = timestampText(row.timestamp).slice(5, 7);
        byMonth.set(month, [...(byMonth.get(month) ?? []), values[index]!]);
      });
      result = { monthlyMeans: Object.fromEntries([...byMonth.entries()].map(([month, seriesValues]) => [month, mean(seriesValues)])) };
    } else {
      const x = rows.map((_, index) => index).filter((index) => values[index] !== null);
      const y = values.filter((value): value is number => value !== null);
      result = analysis === 'linear_trend' ? linearFit(x, y) : theilSen(x, y);
    }
    return jsonSafe({ data: result, provenance: series.provenance, query: { ...(series.query as Record<string, unknown>), analysis }, caveats: [rows.length >= 1_000 && series.nextCursor ? 'Analysis used the first 1,000 page points; choose a coarser resolution or narrower scope for a complete analysis.' : 'Null metric values were excluded from calculations.'], input: { returnedRows: rows.length, nonNullValues: finite.length, dateCoverage: coverage(rows) } });
  }

  async fitSeriesModel(request: SeriesRequest & { model: 'ols_linear' | 'theil_sen_linear' | 'polynomial_2' | 'polynomial_3'; xMetric?: string; yMetric?: string }): Promise<Record<string, unknown>> {
    const yMetric = request.yMetric ?? request.metrics[0];
    if (!yMetric) throw new QueryValidationError('A y metric is required.');
    const series = await this.readSeries({ ...request, metrics: [...new Set([yMetric, ...(request.xMetric ? [request.xMetric] : [])])], pageSize: 5_000 });
    const rows = series.data as Array<Record<string, unknown>>;
    if (rows.length > 5_000) throw new QueryValidationError('Model input exceeds the 5,000-point cap. Use a coarser resolution or narrower range.');
    const pairs = rows.map((row, index) => [request.xMetric ? numberOrNull(row[request.xMetric]) : index, numberOrNull(row[yMetric])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null);
    if (pairs.length < (request.model === 'polynomial_3' ? 6 : 3)) throw new QueryValidationError('Insufficient non-null input for the selected model.');
    const x = pairs.map((pair) => pair[0]); const y = pairs.map((pair) => pair[1]);
    if (new Set(x).size < 2 || new Set(y).size < 2) throw new QueryValidationError('Model input cannot be constant.');
    const fit = request.model === 'ols_linear' ? linearFit(x, y) : request.model === 'theil_sen_linear' ? theilSen(x, y) : polynomialFit(x, y, request.model === 'polynomial_2' ? 2 : 3);
    const predictions = x.map((item) => predict(fit.coefficients as number[], item));
    const residuals = y.map((item, index) => item - predictions[index]);
    return jsonSafe({ data: { model: request.model, xMetric: request.xMetric ?? 'observation_index', yMetric, coefficients: fit.coefficients, rSquared: rSquared(y, predictions), residuals: { mean: mean(residuals), standardDeviation: standardDeviation(residuals), min: Math.min(...residuals), max: Math.max(...residuals) } }, provenance: series.provenance, query: series.query, caveats: ['Descriptive fit only; it is not a physiological or sport-performance model.', 'Rows with null x or y values were excluded.', ...(series.nextCursor ? ['Input was capped at the first 5,000 points after the declared resolution.'] : [])], input: { selectedRows: rows.length, fittedRows: pairs.length, excludedRows: rows.length - pairs.length, cappedRows: series.nextCursor ? 'at least 1 additional page' : 0, dateCoverage: coverage(rows) } });
  }

  // ---- Aerobic decoupling (Pa:Hr / Pw:Hr) and GAP ----

  async deriveDecoupling(request: DeriveDecouplingRequest): Promise<Record<string, unknown>> {
    const activityId = request.activityId?.trim();
    if (!activityId) throw new QueryValidationError('activityId is required. Provide an activity_source_id (e.g. garmin:123) or a canonical activity_id.');

    const identity = await this.resolveActivitySource(activityId);
    const samples = await this.loadActivitySamples(identity.activity_source_id);

    const totalSamples = samples.length;
    if (totalSamples === 0) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', columns: ['heart_rate_bpm', 'power_w', 'speed_mps'], activitySourceId: identity.activity_source_id, sport: identity.sport },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id, sport: identity.sport, provider: identity.provider },
        caveats: [
          'No activity_samples are available for this activity. The stream may not have been synced or the Parquet lake contains no registered manifest for this source.',
          'Decoupling is derived only from FIT samples; it cannot be inferred from summary statistics alone.',
          'Null remains null: insufficient samples produce no decoupling value rather than a synthesized placeholder.',
        ],
        input: { totalSamples },
      });
    }

    if (totalSamples < MIN_TOTAL_SAMPLES) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, sport: identity.sport },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id, sport: identity.sport },
        caveats: [
          `Insufficient samples: ${totalSamples} total points, fewer than the ${MIN_TOTAL_SAMPLES} minimum. Short efforts do not provide stable first/second-half aerobic drift.`,
          'Derived decoupling is descriptive only; do not treat absence as evidence of good or poor aerobic fitness.',
        ],
        input: { totalSamples },
      });
    }

    const isCycling = isCyclingSport(identity.sport);
    const isRunning = isRunningSport(identity.sport);
    // Fallback when sport label is absent: choose metric with better coverage.
    let metricField: 'power_w' | 'speed_mps';
    if (isCycling) metricField = 'power_w';
    else if (isRunning) metricField = 'speed_mps';
    else {
      const powerCoverage = samples.filter((row) => numberOrNull(row.power_w) !== null).length / totalSamples;
      const speedCoverage = samples.filter((row) => numberOrNull(row.speed_mps) !== null).length / totalSamples;
      metricField = powerCoverage > speedCoverage && powerCoverage > 0.5 ? 'power_w' : 'speed_mps';
    }

    const movingThreshold = isCycling ? CYCLING_MOVING_SPEED_THRESHOLD_MPS : RUNNING_MOVING_SPEED_THRESHOLD_MPS;
    const movingSamples = samples.filter((row) => {
      const speed = numberOrNull(row.speed_mps);
      const power = numberOrNull(row.power_w);
      if (speed !== null) return speed > movingThreshold;
      if (isCycling && power !== null) return power > 10;
      return false;
    });

    const movingRatio = movingSamples.length / totalSamples;
    const movingDurationS = (() => {
      const elapsedValues = movingSamples.map((row) => numberOrNull(row.elapsed_s)).filter((value): value is number => value !== null);
      if (elapsedValues.length >= 2) return Math.max(...elapsedValues) - Math.min(...elapsedValues);
      return movingSamples.length;
    })();

    if (movingSamples.length < MIN_MOVING_SAMPLES) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, metricField, sport: identity.sport },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id, metricField },
        caveats: [
          `Insufficient moving samples: ${movingSamples.length} moving points < ${MIN_MOVING_SAMPLES} minimum (total ${totalSamples}, moving ratio ${(movingRatio * 100).toFixed(1)} %).`,
          'Stopped or highly interrupted efforts cannot support a stable first-half vs second-half drift comparison.',
          'Guard: filtered by speed threshold; walk-heavy and stop-heavy activities are excluded by design.',
        ],
        input: { totalSamples, movingSamples: movingSamples.length, movingRatio, movingDurationS },
      });
    }

    if (movingRatio < MOVING_RATIO_THRESHOLD) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, metricField },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: [
          `Moving-time ratio too low: ${(movingRatio * 100).toFixed(1)} % < ${(MOVING_RATIO_THRESHOLD * 100).toFixed(0)} % threshold (moving ${movingSamples.length} / total ${totalSamples}).`,
          'Stop-heavy or trail activities with prolonged pauses bias a naive first/second-half split. Paused portions are excluded and the activity is reported as insufficient for decoupling.',
        ],
        input: { totalSamples, movingSamples: movingSamples.length, movingRatio },
      });
    }

    if (movingDurationS < MIN_MOVING_DURATION_S) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: [
          `Insufficient moving duration: ~${Math.round(movingDurationS)} s < ${MIN_MOVING_DURATION_S} s minimum for a steady aerobic drift comparison.`,
        ],
        input: { movingDurationS, movingSamples: movingSamples.length },
      });
    }

    // Walk-heavy guard for running: median moving speed should look like running, not walking.
    if (!isCycling) {
      const speeds = movingSamples.map((row) => numberOrNull(row.speed_mps)).filter((value): value is number => value !== null);
      if (speeds.length) {
        const medianSpeed = median(speeds);
        if (medianSpeed < WALK_SPEED_THRESHOLD_MPS) {
          return jsonSafe({
            data: null,
            provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, sport: identity.sport },
            query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
            caveats: [
              `Walk-heavy effort: median moving speed ${medianSpeed.toFixed(2)} m/s < ${WALK_SPEED_THRESHOLD_MPS.toFixed(1)} m/s threshold. Aerobic decoupling on walking segments is misleading; the activity is reported as insufficient.`,
              'This guards against the false-low the agent noted for trail ultras where hiking dominates moving time.',
            ],
            input: { medianSpeedMps: medianSpeed, movingSamples: movingSamples.length },
          });
        }
      }
    }

    const validSamples = movingSamples.filter((row) => {
      const hr = numberOrNull(row.heart_rate_bpm);
      const metric = numberOrNull(row[metricField]);
      if (hr === null || metric === null) return false;
      if (hr < 30 || hr > 220) return false;
      if (metric <= 0) return false;
      return true;
    });

    const hrCoverage = validSamples.length / movingSamples.length;
    const metricCoverage = validSamples.length / movingSamples.length;

    if (validSamples.length < MIN_VALID_SAMPLES) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, metricField },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: [
          `Insufficient valid paired HR/${metricField} samples: ${validSamples.length} < ${MIN_VALID_SAMPLES} (HR coverage ${(hrCoverage * 100).toFixed(1)} %, metric coverage ${(metricCoverage * 100).toFixed(1)} %).`,
          'Decoupling requires steady paired heart-rate and power (cycling) or speed (running) across the effort. Missing or sparse sensor streams cannot be inferred.',
        ],
        input: { validSamples: validSamples.length, movingSamples: movingSamples.length, hrCoverage, metricCoverage },
      });
    }

    if (hrCoverage < HR_COVERAGE_THRESHOLD || metricCoverage < METRIC_COVERAGE_THRESHOLD) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, metricField },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: [
          `Sparse paired coverage: HR ${(hrCoverage * 100).toFixed(1)} % / ${metricField} ${(metricCoverage * 100).toFixed(1)} % below thresholds ${(HR_COVERAGE_THRESHOLD * 100).toFixed(0)} % / ${(METRIC_COVERAGE_THRESHOLD * 100).toFixed(0)} %.`,
        ],
        input: { validSamples: validSamples.length, hrCoverage, metricCoverage },
      });
    }

    // Steady first/second halves: chronological split of the valid moving samples.
    const half = Math.floor(validSamples.length / 2);
    const firstHalf = validSamples.slice(0, half);
    const secondHalf = validSamples.slice(half);

    if (firstHalf.length < 60 || secondHalf.length < 60) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: ['Split halves are too small for a stable comparison.'],
        input: { firstHalf: firstHalf.length, secondHalf: secondHalf.length },
      });
    }

    const avgHrFirst = mean(firstHalf.map((row) => numberOrNull(row.heart_rate_bpm) as number));
    const avgHrSecond = mean(secondHalf.map((row) => numberOrNull(row.heart_rate_bpm) as number));
    const avgMetricFirst = mean(firstHalf.map((row) => numberOrNull(row[metricField]) as number));
    const avgMetricSecond = mean(secondHalf.map((row) => numberOrNull(row[metricField]) as number));

    if (avgHrFirst === 0 || avgMetricFirst === 0) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: ['First-half averages are degenerate (zero divisor); cannot form a drift ratio.'],
        input: { avgHrFirst, avgMetricFirst },
      });
    }

    const efficiencyFirst = avgMetricFirst / avgHrFirst;
    const efficiencySecond = avgMetricSecond / avgHrSecond;
    if (efficiencyFirst === 0) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: ['Efficiency ratio is degenerate; cannot compute decoupling.'],
        input: { efficiencyFirst },
      });
    }

    const decouplingPct = (1 - efficiencySecond / efficiencyFirst) * 100;
    const hrDriftPct = avgHrFirst === 0 ? null : ((avgHrSecond - avgHrFirst) / avgHrFirst) * 100;
    const metricDriftPct = avgMetricFirst === 0 ? null : ((avgMetricSecond - avgMetricFirst) / avgMetricFirst) * 100;

    const medianSpeedMps = (() => {
      const speeds = movingSamples.map((row) => numberOrNull(row.speed_mps)).filter((value): value is number => value !== null);
      return speeds.length ? median(speeds) : null;
    })();

    return jsonSafe({
      data: {
        activityId: identity.activity_id,
        activitySourceId: identity.activity_source_id,
        provider: identity.provider,
        sport: identity.sport,
        startedAtUtc: identity.started_at_utc,
        metricUsed: metricField,
        decouplingPct,
        efficiencyFirst,
        efficiencySecond,
        avgHrFirst,
        avgHrSecond,
        avgMetricFirst,
        avgMetricSecond,
        hrDriftPct,
        metricDriftPct,
        samples: { totalSamples, movingSamples: movingSamples.length, validSamples: validSamples.length, firstHalf: firstHalf.length, secondHalf: secondHalf.length, movingRatio, movingDurationS, medianSpeedMps },
        interpretation: {
          decouplingPct,
          direction: decouplingPct > 5 ? 'hr_drift_positive' : decouplingPct < -5 ? 'negative_drift' : 'stable',
          note: 'Positive decoupling means HR rose relative to power/speed in the second half ( cardiac drift at similar output).',
        },
      },
      provenance: {
        dataset: 'activity_samples',
        derivation: 'derived',
        method: 'Pw:Hr or Pa:Hr drift across steady first/second moving halves (chronological split of valid HR+metric samples). Efficiency = metric / HR; decouplingPct = (1 - EF_second / EF_first) * 100.',
        metricField,
        columns: ['heart_rate_bpm', metricField, 'speed_mps', 'timestamp_utc', 'elapsed_s'],
        activitySourceId: identity.activity_source_id,
      },
      query: { activityId, resolvedActivitySourceId: identity.activity_source_id, metricField, sport: identity.sport },
      caveats: [
        'Derived decoupling is descriptive only; it is not a physiological model or training prescription.',
        'Derived values never overwrite provider-supplied decoupling (e.g. Intervals decoupling in metrics_json); provider values remain authoritative when present.',
        'First/second halves are chronological moving halves after walk/stop filtering; warm-up and cool-down are not separately excluded — steady-state drift should be interpreted with that limit in mind.',
        'Null remains null: when samples are sparse, walk-heavy, or stop-heavy the tool returns data:null with explanatory caveats rather than a fabricated value.',
        `Thresholds: total ≥${MIN_TOTAL_SAMPLES}, moving ≥${MIN_MOVING_SAMPLES}, valid ≥${MIN_VALID_SAMPLES}, movingRatio ≥${(MOVING_RATIO_THRESHOLD * 100).toFixed(0)} %, movingDuration ≥${MIN_MOVING_DURATION_S}s, HR/metric coverage ≥${(HR_COVERAGE_THRESHOLD * 100).toFixed(0)} %.`,
      ],
      input: { totalSamples, movingSamples: movingSamples.length, validSamples: validSamples.length, movingRatio, medianSpeedMps, metricField },
    });
  }

  async deriveGap(request: DeriveGapRequest): Promise<Record<string, unknown>> {
    const activityId = request.activityId?.trim();
    if (!activityId) throw new QueryValidationError('activityId is required. Provide an activity_source_id (e.g. garmin:123) or a canonical activity_id.');

    const identity = await this.resolveActivitySource(activityId);
    const samples = await this.loadActivitySamples(identity.activity_source_id);

    const totalSamples = samples.length;
    if (totalSamples === 0) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: ['No activity_samples are available for this activity; GAP cannot be derived.'],
        input: { totalSamples },
      });
    }

    const isRunning = isRunningSport(identity.sport);
    const isCycling = isCyclingSport(identity.sport);
    if (isCycling) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id, sport: identity.sport },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id, sport: identity.sport },
        caveats: [
          'GAP (grade-adjusted pace) is a running metric. This activity is cycling; grade-adjusted pace is not applicable. Use power/HR decoupling for cycling aerobic assessment instead.',
        ],
        input: { sport: identity.sport },
      });
    }

    // Non-running, non-cycling: still attempt GAP but flag as generic.
    const expectedRunning = isRunning || (!identity.sport);

    // Moving filter for GAP: requires speed; altitude or grade for the grade model.
    const movingSamples = samples
      .filter((row) => {
        const speed = numberOrNull(row.speed_mps);
        if (speed === null || speed <= RUNNING_MOVING_SPEED_THRESHOLD_MPS) return false;
        return true;
      })
      .map((row, index, array) => {
        // Grades are ordered by timestamp; compute fallback grade when grade_pct is missing.
        const gradePct = numberOrNull(row.grade_pct);
        if (gradePct !== null && Number.isFinite(gradePct)) return { row, grade: gradePct / 100 };
        // Fallback: derive from altitude/distance delta over a short window.
        const previous = array[Math.max(0, index - 1)] as SampleRow | undefined;
        const altitude = numberOrNull(row.altitude_m);
        const previousAltitude = previous ? numberOrNull(previous.altitude_m) : null;
        const distance = numberOrNull(row.distance_m);
        const previousDistance = previous ? numberOrNull(previous.distance_m) : null;
        if (altitude !== null && previousAltitude !== null && distance !== null && previousDistance !== null) {
          const distanceDelta = distance - previousDistance;
          if (distanceDelta > 5) return { row, grade: (altitude - previousAltitude) / distanceDelta };
        }
        return { row, grade: 0 };
      });

    const gapEligibleSamples = movingSamples.filter(({ row }) => {
      const speed = numberOrNull(row.speed_mps);
      return speed !== null && speed > 0;
    });

    const totalMovingForGap = gapEligibleSamples.length;
    if (totalMovingForGap < MIN_MOVING_SAMPLES) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id, sport: identity.sport },
        caveats: [
          `Insufficient moving samples for GAP: ${totalMovingForGap} < ${MIN_MOVING_SAMPLES}. GAP requires steady moving running samples with speed and grade/altitude.`,
        ],
        input: { gapEligibleSamples: totalMovingForGap, totalSamples },
      });
    }

    const gaps = gapEligibleSamples.map(({ row, grade }) => {
      const speed = numberOrNull(row.speed_mps) as number;
      const cost = runningCost(grade);
      const factor = cost / 3.6;
      const gapSpeed = speed * factor;
      const gapPaceSPerKm = gapSpeed > 0 ? 1000 / gapSpeed : null;
      const paceSPerKm = speed > 0 ? 1000 / speed : null;
      return { speed, grade, cost, factor, gapSpeed, gapPaceSPerKm, paceSPerKm, altitude: numberOrNull(row.altitude_m), distance: numberOrNull(row.distance_m) };
    }).filter((item) => item.gapPaceSPerKm !== null && Number.isFinite(item.gapPaceSPerKm));

    if (gaps.length < MIN_VALID_SAMPLES) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: ['Insufficient valid GAP points after grade modeling.'],
        input: { gaps: gaps.length },
      });
    }

    const avgSpeed = mean(gaps.map((item) => item.speed));
    const avgGapSpeed = mean(gaps.map((item) => item.gapSpeed));
    const avgGrade = mean(gaps.map((item) => item.grade));
    const avgPaceSPerKm = 1000 / avgSpeed;
    const avgGapPaceSPerKm = 1000 / avgGapSpeed;
    const minPace = Math.min(...gaps.map((item) => item.paceSPerKm as number));
    const maxPace = Math.max(...gaps.map((item) => item.paceSPerKm as number));
    const minGapPace = Math.min(...gaps.map((item) => item.gapPaceSPerKm as number));
    const maxGapPace = Math.max(...gaps.map((item) => item.gapPaceSPerKm as number));

    // Elevation gain/loss from altitude when available
    const altitudes = samples.map((row) => numberOrNull(row.altitude_m)).filter((value): value is number => value !== null);
    let elevationGainM: number | null = null;
    let elevationLossM: number | null = null;
    if (altitudes.length >= 2) {
      let gain = 0;
      let loss = 0;
      for (let index = 1; index < altitudes.length; index++) {
        const delta = altitudes[index]! - altitudes[index - 1]!;
        if (delta > 0) gain += delta;
        else loss += Math.abs(delta);
      }
      elevationGainM = gain;
      elevationLossM = loss;
    }

    const distanceM = (() => {
      const distances = samples.map((row) => numberOrNull(row.distance_m)).filter((value): value is number => value !== null);
      if (distances.length < 2) return null;
      return Math.max(...distances) - Math.min(...distances);
    })();

    // Guard walk-heavy for GAP as well.
    const medianSpeed = median(gaps.map((item) => item.speed));
    if (medianSpeed < WALK_SPEED_THRESHOLD_MPS) {
      return jsonSafe({
        data: null,
        provenance: { dataset: 'activity_samples', derivation: 'derived', activitySourceId: identity.activity_source_id },
        query: { activityId, resolvedActivitySourceId: identity.activity_source_id },
        caveats: [
          `Walk-heavy effort: median speed ${medianSpeed.toFixed(2)} m/s < ${WALK_SPEED_THRESHOLD_MPS.toFixed(1)} m/s. GAP on predominantly walking segments is not meaningful and is suppressed.`,
        ],
        input: { medianSpeedMps: medianSpeed, gapSamples: gaps.length },
      });
    }

    return jsonSafe({
      data: {
        activityId: identity.activity_id,
        activitySourceId: identity.activity_source_id,
        provider: identity.provider,
        sport: identity.sport,
        startedAtUtc: identity.started_at_utc,
        method: 'Minetti 2002 cost model',
        samples: { totalSamples, movingSamplesForGap: gaps.length, expectedRunning },
        averages: {
          speed_mps: avgSpeed,
          gap_speed_mps: avgGapSpeed,
          pace_s_per_km: avgPaceSPerKm,
          gap_pace_s_per_km: avgGapPaceSPerKm,
          grade_pct: avgGrade * 100,
        },
        ranges: {
          pace_s_per_km: { min: minPace, max: maxPace },
          gap_pace_s_per_km: { min: minGapPace, max: maxGapPace },
        },
        elevation: { gain_m: elevationGainM, loss_m: elevationLossM, distance_m: distanceM },
        interpretation: {
          note: 'GAP re-expresses each moving second as its flat-equivalent pace for the same metabolic cost. Uphill → GAP faster than raw pace; downhill → GAP slower than raw pace.',
        },
      },
      provenance: {
        dataset: 'activity_samples',
        derivation: 'derived',
        model: 'Minetti et al. 2002: C(g) = 155.4 g^5 -30.4 g^4 -43.3 g^3 +46.3 g^2 +19.5 g +3.6; GAP factor = C(g)/C(0); GAP speed = speed * factor',
        columns: ['speed_mps', 'altitude_m', 'grade_pct', 'distance_m', 'timestamp_utc'],
        activitySourceId: identity.activity_source_id,
      },
      query: { activityId, resolvedActivitySourceId: identity.activity_source_id, sport: identity.sport },
      caveats: [
        'Derived GAP is descriptive only; it is not a certified replacement for Strava or device GAP and is not a physiological performance model.',
        'Derived GAP never overwrites a provider-supplied grade_adjusted_pace when present; treat provider values as authoritative.',
        'Grades are clamped to ±30 % and smoothed only lightly; noisy altitude and GPS can still bias short rolling segments — prefer the averaged GAP for the whole activity over per-second values.',
        ...(expectedRunning ? [] : ['Sport is not running; GAP is reported but should be interpreted cautiously outside running/trail.']),
      ],
      input: { totalSamples, gapSamples: gaps.length, avgGradePct: avgGrade * 100 },
    });
  }

  private async resolveActivitySource(activityId: string): Promise<ActivitySourceIdentity> {
    const trimmed = activityId.trim();
    if (!trimmed) throw new QueryValidationError('activityId is required.');
    const bySource = await this.repository.rows<ActivitySourceIdentity>(`
      SELECT source.activity_source_id, source.provider, activity.sport, source.activity_id, cast(activity.started_at_utc AS VARCHAR) AS started_at_utc
      FROM activity_sources AS source
      JOIN activities AS activity USING (activity_id)
      WHERE source.activity_source_id = $activityId
      LIMIT 1
    `, { activityId: trimmed });
    if (bySource[0]) return bySource[0];
    const byLogical = await this.repository.rows<ActivitySourceIdentity>(`
      SELECT source.activity_source_id, source.provider, activity.sport, source.activity_id, cast(activity.started_at_utc AS VARCHAR) AS started_at_utc
      FROM activity_sources AS source
      JOIN activities AS activity USING (activity_id)
      WHERE source.activity_id = $activityId
      ORDER BY CASE source.provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, source.activity_source_id ASC
      LIMIT 1
    `, { activityId: trimmed });
    if (byLogical[0]) return byLogical[0];
    throw new QueryValidationError(`No activity source matched ${trimmed}. Use find_activities to locate a valid activityId or activity_source_id.`);
  }

  private async loadActivitySamples(activitySourceId: string): Promise<SampleRow[]> {
    const relation = await this.repository.datasetRelation('activity_samples');
    const source = sourceRelation(relation);
    const rows = await this.repository.rows<SampleRow>(`
      SELECT timestamp_utc, elapsed_s, distance_m, altitude_m, heart_rate_bpm, power_w, speed_mps, grade_pct
      FROM ${source} AS source
      WHERE activity_source_id = $activitySourceId
      ORDER BY timestamp_utc ASC NULLS LAST, elapsed_s ASC NULLS LAST
    `, { activitySourceId });
    return rows;
  }
}

function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function timestampText(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function standardDeviation(values: number[]): number { const center = mean(values); return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length); }
function rolling(values: Array<number | null>, window: number, fn: (values: number[]) => number): Array<number | null> { return values.map((_, index) => { const chunk = values.slice(Math.max(0, index - window + 1), index + 1).filter((item): item is number => item !== null); return chunk.length ? fn(chunk) : null; }); }
function pearson(x: number[], y: number[]): number | null { const sx = standardDeviation(x); const sy = standardDeviation(y); if (sx === 0 || sy === 0) return null; const mx = mean(x); const my = mean(y); return x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0) / (x.length * sx * sy); }
function ranks(values: number[]): number[] { const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value); const output = new Array(values.length); let index = 0; while (index < ordered.length) { let end = index; while (end + 1 < ordered.length && ordered[end + 1].value === ordered[index].value) end++; const rank = (index + end + 2) / 2; for (let cursor = index; cursor <= end; cursor++) output[ordered[cursor].index] = rank; index = end + 1; } return output; }
function linearFit(x: number[], y: number[]): { coefficients: number[]; slope: number; intercept: number } { const mx = mean(x); const my = mean(y); const denominator = x.reduce((sum, value) => sum + (value - mx) ** 2, 0); if (denominator === 0) throw new QueryValidationError('x values are constant.'); const slope = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0) / denominator; const intercept = my - slope * mx; return { coefficients: [intercept, slope], slope, intercept }; }
function theilSen(x: number[], y: number[]): { coefficients: number[]; slope: number; intercept: number } { const slopes: number[] = []; for (let left = 0; left < x.length; left++) for (let right = left + 1; right < x.length; right++) if (x[right] !== x[left]) slopes.push((y[right] - y[left]) / (x[right] - x[left])); const slope = median(slopes); const intercept = median(x.map((value, index) => y[index] - slope * value)); return { coefficients: [intercept, slope], slope, intercept }; }
function polynomialFit(x: number[], y: number[], degree: number): { coefficients: number[] } { const size = degree + 1; const matrix = Array.from({ length: size }, (_, row) => Array.from({ length: size + 1 }, (_, column) => column === size ? x.reduce((sum, value, index) => sum + y[index] * value ** row, 0) : x.reduce((sum, value) => sum + value ** (row + column), 0))); for (let pivot = 0; pivot < size; pivot++) { let best = pivot; for (let row = pivot + 1; row < size; row++) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row; [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]]; if (Math.abs(matrix[pivot][pivot]) < 1e-12) throw new QueryValidationError('Polynomial fit is singular.'); const scale = matrix[pivot][pivot]; for (let column = pivot; column <= size; column++) matrix[pivot][column] /= scale; for (let row = 0; row < size; row++) if (row !== pivot) { const factor = matrix[row][pivot]; for (let column = pivot; column <= size; column++) matrix[row][column] -= factor * matrix[pivot][column]; } } return { coefficients: matrix.map((row) => row[size]) }; }
function predict(coefficients: number[], x: number): number { return coefficients.reduce((sum, coefficient, index) => sum + coefficient * x ** index, 0); }
function rSquared(actual: number[], predicted: number[]): number | null { const total = actual.reduce((sum, value) => sum + (value - mean(actual)) ** 2, 0); return total === 0 ? null : 1 - actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0) / total; }
function coverage(rows: Array<Record<string, unknown>>): { start: unknown; end: unknown } { return { start: rows[0]?.timestamp ?? null, end: rows.at(-1)?.timestamp ?? null }; }
