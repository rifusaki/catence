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

const resolutionIntervals: Record<Exclude<Resolution, 'raw' | 'auto'>, string> = {
  '1m': 'minute', '5m': 'minute', '15m': 'minute', '1h': 'hour', day: 'day', week: 'week',
};

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
    if (resolution === 'auto') {
      const probe = await this.repository.rows(`SELECT count(*)::BIGINT AS row_count FROM ${source} AS source ${where}`, values);
      const rowCount = Number(probe[0]?.row_count ?? 0);
      resolution = rowCount > pageSize
        ? dataset.name === 'activity_samples' ? '1m'
          : ['daily_metrics', 'daily_health', 'nutrition_days', 'nutrition_items'].includes(dataset.name) ? 'week'
            : 'day'
        : 'raw';
    }
    const offset = cursor?.offset ?? 0;
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
    return jsonSafe({
      data: rows,
      provenance: { dataset: dataset.name, source: dataset.relation ?? 'registered stream_manifest Parquet only', columns: dataset.provenanceColumns },
      query: { dataset: dataset.name, metrics, filters: request.filters ?? [], startDate: request.startDate, endDate: request.endDate, activityId: request.activityId, requestedResolution, resolution, pageSize },
      caveats: resolution !== requestedResolution && requestedResolution === 'auto' ? ['Automatically downsampled to stay within the first response page. Use the returned cursor for later pages.'] : [],
      nextCursor: hasMore ? encodeCursor({ hash: fingerprint, offset: offset + pageSize, resolution }) : undefined,
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
      selections.unshift(`${bucket} AS bucket`);
      groups.unshift(bucket);
    }
    for (const [index, metric] of request.metrics.entries()) {
      const column = getColumn(dataset, metric.column);
      if (metric.operation !== 'count' && !isNumeric(column)) throw new QueryValidationError(`${metric.column} is not numeric.`);
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
    const orderBy = request.orderBy?.column;
    const aliases = selections.map((selection) => selection.match(/AS "?([A-Za-z_][A-Za-z0-9_]*)"?$/i)?.[1]).filter(Boolean) as string[];
    if (orderBy && !aliases.includes(orderBy) && orderBy !== 'bucket' && !dimensions.includes(orderBy)) throw new QueryValidationError('orderBy must name a selected dimension, bucket, or aggregation alias.');
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
