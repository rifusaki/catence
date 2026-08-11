import { QueryValidationError } from './catalog.js';
import { jsonSafe, type ReadOnlyRepository } from './repository.js';

/**
 * A small, intentionally opinionated layer over Catence's general query
 * surface.  It keeps the common wellness/recovery questions compact while
 * retaining the same normalized daily-health and canonical-training facts.
 */
export const WELLNESS_METRICS = [
  'resting_hr_bpm',
  'hrv_ms',
  'sleep_seconds',
  'sleep_score',
  'stress',
  'body_battery',
  'readiness',
  'spo2_pct',
  'steps',
  'training_load',
  'activity_count',
  'distance_m',
  'moving_s',
] as const;

export type WellnessMetric = (typeof WELLNESS_METRICS)[number];
export type WellnessCorrelationRequest = {
  metricA: WellnessMetric;
  metricB: WellnessMetric;
  startDate?: string;
  endDate?: string;
  method?: 'pearson' | 'spearman';
  lagDays?: number;
  scanLags?: boolean;
};

export type WellnessBaselineRequest = {
  metrics?: WellnessMetric[];
  endDate?: string;
  windowDays?: number;
};

export type WellnessAnomalyRequest = {
  metrics?: WellnessMetric[];
  startDate?: string;
  endDate?: string;
  zThreshold?: number;
};

export type WellnessCoverageRequest = {
  metrics?: WellnessMetric[];
  startDate?: string;
  endDate?: string;
};

type WellnessRow = { date: string } & Record<WellnessMetric, number | null>;
type CorrelationResult = {
  metricA: WellnessMetric;
  metricB: WellnessMetric;
  lagDays: number;
  method: 'pearson' | 'spearman';
  pairedDays: number;
  correlation: number | null;
  firstPairedDate: string | null;
  lastPairedDate: string | null;
};

const DEFAULT_BASELINE_METRICS: WellnessMetric[] = ['resting_hr_bpm', 'hrv_ms', 'sleep_score', 'stress', 'body_battery', 'training_load'];
const DEFAULT_ANOMALY_METRICS: WellnessMetric[] = ['resting_hr_bpm', 'hrv_ms', 'sleep_score', 'stress', 'body_battery'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number): string {
  return addDays(date, -days);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function pearson(x: number[], y: number[]): number | null {
  const xDeviation = standardDeviation(x);
  const yDeviation = standardDeviation(y);
  if (xDeviation === 0 || yDeviation === 0) return null;
  const xMean = mean(x);
  const yMean = mean(y);
  return x.reduce((sum, value, index) => sum + (value - xMean) * (y[index]! - yMean), 0) / (x.length * xDeviation * yDeviation);
}

function ranks(values: number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = new Array<number>(values.length);
  let index = 0;
  while (index < ordered.length) {
    let end = index;
    while (end + 1 < ordered.length && ordered[end + 1]!.value === ordered[index]!.value) end++;
    const rank = (index + end + 2) / 2;
    for (let cursor = index; cursor <= end; cursor++) result[ordered[cursor]!.index] = rank;
    index = end + 1;
  }
  return result;
}

function metricList(metrics: WellnessMetric[] | undefined, fallback: WellnessMetric[]): WellnessMetric[] {
  const selected = [...new Set(metrics?.length ? metrics : fallback)];
  if (selected.length === 0 || selected.length > 12) throw new QueryValidationError('Choose between one and twelve wellness metrics.');
  for (const metric of selected) {
    if (!(WELLNESS_METRICS as readonly string[]).includes(metric)) throw new QueryValidationError(`Unsupported wellness metric: ${metric}.`);
  }
  return selected;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export class WellnessService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async correlate(request: WellnessCorrelationRequest): Promise<Record<string, unknown>> {
    this.assertMetric(request.metricA);
    this.assertMetric(request.metricB);
    const range = await this.resolveRange(request.startDate, request.endDate, 90);
    const rows = await this.dailyRows(range.startDate, range.endDate);
    const method = request.method ?? 'pearson';
    const requestedLag = request.lagDays ?? 0;
    if (!Number.isInteger(requestedLag) || requestedLag < -30 || requestedLag > 30) throw new QueryValidationError('lagDays must be an integer from -30 to 30.');
    const lags = request.scanLags ? Array.from({ length: 15 }, (_, index) => index - 7) : [requestedLag];
    const results = lags.map((lagDays) => this.correlation(rows, request.metricA, request.metricB, lagDays, method));
    const selected = request.scanLags
      ? [...results].sort((left, right) => (right.correlation === null ? -1 : Math.abs(right.correlation)) - (left.correlation === null ? -1 : Math.abs(left.correlation)) || right.pairedDays - left.pairedDays)[0]!
      : results[0]!;
    return jsonSafe({
      data: request.scanLags ? { selected, scannedLags: results } : selected,
      provenance: { relations: ['daily_health', 'canonical_activity_training'], dailyHealthProvider: 'Garmin when available' },
      query: { ...request, startDate: range.startDate, endDate: range.endDate, method, lagDays: requestedLag, scanLags: request.scanLags ?? false },
      caveats: [
        'A positive lag pairs metricA on date D with metricB on D plus lagDays; correlation is descriptive, not causal.',
        'Null or missing values are excluded pairwise. A day without training has zero training load only when a daily-health row exists; a wholly absent day remains missing.',
      ],
    });
  }

  async baselines(request: WellnessBaselineRequest): Promise<Record<string, unknown>> {
    const metrics = metricList(request.metrics, DEFAULT_BASELINE_METRICS);
    const windowDays = request.windowDays ?? 28;
    if (!Number.isInteger(windowDays) || windowDays < 7 || windowDays > 365) throw new QueryValidationError('windowDays must be an integer from 7 to 365.');
    const range = await this.resolveRange(undefined, request.endDate, windowDays);
    const rows = await this.dailyRows(range.startDate, range.endDate);
    const data = metrics.map((metric) => {
      const observations = rows.flatMap((row) => row[metric] === null ? [] : [{ date: row.date, value: row[metric]! }]);
      const values = observations.map((observation) => observation.value);
      const latest = observations.at(-1) ?? null;
      const average = values.length ? mean(values) : null;
      const deviation = values.length > 1 ? standardDeviation(values) : null;
      return {
        metric,
        observations: values.length,
        missingDays: windowDays - values.length,
        mean: average,
        standardDeviation: deviation,
        lowerBand: average === null || deviation === null ? null : average - deviation,
        upperBand: average === null || deviation === null ? null : average + deviation,
        latestDate: latest?.date ?? null,
        latestValue: latest?.value ?? null,
        latestZScore: latest === null || average === null || deviation === null || deviation === 0 ? null : (latest.value - average) / deviation,
      };
    });
    return jsonSafe({
      data,
      provenance: { relations: ['daily_health', 'canonical_activity_training'], dailyHealthProvider: 'Garmin when available' },
      query: { metrics, endDate: range.endDate, windowDays, startDate: range.startDate },
      caveats: ['Baselines are descriptive trailing-window statistics, not medical or training recommendations.', 'Missing values are not treated as zero.'],
    });
  }

  async anomalies(request: WellnessAnomalyRequest): Promise<Record<string, unknown>> {
    const metrics = metricList(request.metrics, DEFAULT_ANOMALY_METRICS);
    const range = await this.resolveRange(request.startDate, request.endDate, 30);
    const zThreshold = request.zThreshold ?? 2;
    if (!Number.isFinite(zThreshold) || zThreshold < 1 || zThreshold > 5) throw new QueryValidationError('zThreshold must be between 1 and 5.');
    const rows = await this.dailyRows(range.startDate, range.endDate);
    const flagged = new Map<string, Array<Record<string, unknown>>>();
    const summaries = metrics.map((metric) => {
      const values = rows.map((row) => row[metric]).filter((value): value is number => value !== null);
      const average = values.length ? mean(values) : null;
      const deviation = values.length > 1 ? standardDeviation(values) : null;
      const anomalies = rows.flatMap((row) => {
        const value = row[metric];
        if (value === null || average === null || deviation === null || deviation === 0) return [];
        const zScore = (value - average) / deviation;
        if (Math.abs(zScore) < zThreshold) return [];
        const anomaly = { metric, date: row.date, value, zScore, direction: zScore > 0 ? 'above_baseline' : 'below_baseline' };
        flagged.set(row.date, [...(flagged.get(row.date) ?? []), anomaly]);
        return [anomaly];
      });
      return { metric, observations: values.length, mean: average, standardDeviation: deviation, anomalies };
    });
    return jsonSafe({
      data: {
        metrics: summaries,
        crossMetricDays: [...flagged.entries()].filter(([, items]) => items.length > 1).map(([date, items]) => ({ date, anomalies: items })),
      },
      provenance: { relations: ['daily_health', 'canonical_activity_training'], dailyHealthProvider: 'Garmin when available' },
      query: { metrics, startDate: range.startDate, endDate: range.endDate, zThreshold },
      caveats: ['Anomalies are statistical outliers in the selected period, not diagnoses or explanations.', 'Metrics with fewer than two observations, constant values, or missing days do not produce z-scores.'],
    });
  }

  async coverage(request: WellnessCoverageRequest): Promise<Record<string, unknown>> {
    const metrics = metricList(request.metrics, [...WELLNESS_METRICS]);
    const range = await this.resolveRange(request.startDate, request.endDate, 90);
    const rows = await this.dailyRows(range.startDate, range.endDate);
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const dates = dateRange(range.startDate, range.endDate);
    const data = metrics.map((metric) => {
      const presentDates = dates.filter((date) => byDate.get(date)?.[metric] !== null);
      return {
        metric,
        expectedDays: dates.length,
        presentDays: presentDates.length,
        missingDays: dates.length - presentDates.length,
        firstPresentDate: presentDates[0] ?? null,
        lastPresentDate: presentDates.at(-1) ?? null,
        missingDates: dates.filter((date) => byDate.get(date)?.[metric] === null).slice(0, 100),
        missingDatesTruncated: dates.length - presentDates.length > 100,
      };
    });
    const errors = await this.repository.rows<{ count: number | bigint }>('SELECT count(*) AS count FROM normalization_errors WHERE resolved_at IS NULL');
    return jsonSafe({
      data: { metrics: data, unresolvedExtractionErrors: Number(errors[0]?.count ?? 0) },
      provenance: { relations: ['daily_health', 'canonical_activity_training', 'normalization_errors'], dailyHealthProvider: 'Garmin when available' },
      query: { metrics, startDate: range.startDate, endDate: range.endDate },
      caveats: ['Coverage reports unavailable observations; it does not infer rest days, zero load, or negative health signals from missing records.', 'Only the first 100 missing dates per metric are returned.'],
    });
  }

  private assertMetric(metric: string): asserts metric is WellnessMetric {
    if (!(WELLNESS_METRICS as readonly string[]).includes(metric)) throw new QueryValidationError(`Unsupported wellness metric: ${metric}.`);
  }

  private async resolveRange(startDate: string | undefined, endDate: string | undefined, defaultDays: number): Promise<{ startDate: string; endDate: string }> {
    const latest = await this.repository.rows<{ latest_date: string | Date | null }>(`
      SELECT max(date) AS latest_date FROM (
        SELECT metric_date AS date FROM daily_health
        UNION ALL
        SELECT cast(started_at_utc AS DATE) AS date FROM canonical_activity_training
      ) AS known_dates
    `);
    const latestDate = latest[0]?.latest_date instanceof Date
      ? latest[0].latest_date.toISOString().slice(0, 10)
      : typeof latest[0]?.latest_date === 'string' ? latest[0].latest_date.slice(0, 10) : today();
    const resolvedEndDate = endDate ?? latestDate;
    const resolvedStartDate = startDate ?? subtractDays(resolvedEndDate, defaultDays - 1);
    if (resolvedStartDate > resolvedEndDate) throw new QueryValidationError('startDate must be on or before endDate.');
    if (Date.parse(`${resolvedEndDate}T00:00:00Z`) - Date.parse(`${resolvedStartDate}T00:00:00Z`) > 730 * 86_400_000) {
      throw new QueryValidationError('Wellness queries are limited to a two-year range. Narrow the requested dates.');
    }
    return { startDate: resolvedStartDate, endDate: resolvedEndDate };
  }

  private async dailyRows(startDate: string, endDate: string): Promise<WellnessRow[]> {
    return this.repository.rows<WellnessRow>(`
      WITH health AS (
        SELECT cast(metric_date AS VARCHAR) AS date,
          resting_hr_bpm, hrv_ms, sleep_seconds, sleep_score, stress, body_battery, readiness, spo2_pct, steps
        FROM daily_health
        WHERE metric_date BETWEEN cast($startDate AS DATE) AND cast($endDate AS DATE)
      ), training AS (
        SELECT cast(cast(started_at_utc AS DATE) AS VARCHAR) AS date,
          sum(training_load) AS training_load,
          count(*)::DOUBLE AS activity_count,
          sum(distance_m) AS distance_m,
          sum(moving_s) AS moving_s
        FROM canonical_activity_training
        WHERE cast(started_at_utc AS DATE) BETWEEN cast($startDate AS DATE) AND cast($endDate AS DATE)
        GROUP BY 1
      ), dates AS (
        SELECT date FROM health UNION SELECT date FROM training
      )
      SELECT dates.date,
        health.resting_hr_bpm, health.hrv_ms, health.sleep_seconds, health.sleep_score, health.stress,
        health.body_battery, health.readiness, health.spo2_pct, health.steps,
        CASE WHEN health.date IS NULL THEN NULL ELSE coalesce(training.training_load, 0) END AS training_load,
        CASE WHEN health.date IS NULL THEN NULL ELSE coalesce(training.activity_count, 0) END AS activity_count,
        CASE WHEN health.date IS NULL THEN NULL ELSE coalesce(training.distance_m, 0) END AS distance_m,
        CASE WHEN health.date IS NULL THEN NULL ELSE coalesce(training.moving_s, 0) END AS moving_s
      FROM dates
      LEFT JOIN health USING (date)
      LEFT JOIN training USING (date)
      ORDER BY dates.date ASC
    `, { startDate, endDate }).then((rows) => rows.map((row) => {
      const normalized = { date: String(row.date) } as WellnessRow;
      for (const metric of WELLNESS_METRICS) normalized[metric] = numberOrNull(row[metric]);
      return normalized;
    }));
  }

  private correlation(rows: WellnessRow[], metricA: WellnessMetric, metricB: WellnessMetric, lagDays: number, method: 'pearson' | 'spearman'): CorrelationResult {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const pairs = rows.flatMap((row) => {
      const other = byDate.get(addDays(row.date, lagDays));
      const first = row[metricA];
      const second = other?.[metricB] ?? null;
      return first === null || second === null ? [] : [{ date: row.date, pairedDate: other!.date, first, second }];
    });
    const x = pairs.map((pair) => pair.first);
    const y = pairs.map((pair) => pair.second);
    return {
      metricA,
      metricB,
      lagDays,
      method,
      pairedDays: pairs.length,
      correlation: pairs.length < 3 ? null : pearson(method === 'spearman' ? ranks(x) : x, method === 'spearman' ? ranks(y) : y),
      firstPairedDate: pairs[0]?.date ?? null,
      lastPairedDate: pairs.at(-1)?.date ?? null,
    };
  }
}
