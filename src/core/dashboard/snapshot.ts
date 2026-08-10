import type { ReadOnlyRepository } from '../query/repository.js';

export type DashboardOptions = {
  endDate: string;
  days: number;
};

type DashboardHealthRow = {
  metric_date: string;
  provider: string;
  resting_hr_bpm: number | null;
  hrv_ms: number | null;
  sleep_seconds: number | null;
  sleep_score: number | null;
  stress: number | null;
  body_battery: number | null;
  readiness: number | null;
  steps: number | null;
};

type DashboardWeekRow = {
  week_start: string;
  activity_count: number;
  distance_m: number | null;
  moving_s: number | null;
  elevation_gain_m: number | null;
  training_load: number | null;
};

type DashboardActivityRow = {
  activity_id: string;
  started_at_utc: string;
  sport: string | null;
  name: string | null;
  distance_m: number | null;
  moving_s: number | null;
  elevation_gain_m: number | null;
  training_load: number | null;
  provider: string;
};

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/**
 * Fixed dashboard facts for the local Console.
 *
 * The service deliberately reads Catence's existing canonical projections
 * instead of adding a visualization-specific store or materialized mirror.
 */
export class DashboardSnapshotService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async snapshot(options: DashboardOptions): Promise<Record<string, unknown>> {
    const startDate = subtractDays(options.endDate, options.days - 1);
    // DuckDB's native Node binding shares statement state on one connection.
    // Keep dashboard reads sequential just like the existing status service.
    const health = await this.repository.rows<DashboardHealthRow>(`
        SELECT cast(metric_date AS VARCHAR) AS metric_date, provider,
          resting_hr_bpm, hrv_ms, sleep_seconds, sleep_score, stress, body_battery, readiness, steps
        FROM daily_health
        WHERE metric_date BETWEEN $startDate AND $endDate
        ORDER BY metric_date ASC
      `, { startDate, endDate: options.endDate });
    const weeklyTraining = await this.repository.rows<DashboardWeekRow>(`
        SELECT cast(cast(date_trunc('week', started_at_utc) AS DATE) AS VARCHAR) AS week_start,
          count(*)::INTEGER AS activity_count,
          sum(distance_m) AS distance_m,
          sum(moving_s) AS moving_s,
          sum(elevation_gain_m) AS elevation_gain_m,
          sum(training_load) AS training_load
        FROM canonical_activity_training
        WHERE cast(started_at_utc AS DATE) BETWEEN $startDate AND $endDate
        GROUP BY week_start
        ORDER BY week_start ASC
      `, { startDate, endDate: options.endDate });
    const recentActivities = await this.repository.rows<DashboardActivityRow>(`
        SELECT activity_id, cast(started_at_utc AS VARCHAR) AS started_at_utc, sport, name,
          distance_m, moving_s, elevation_gain_m, training_load, provider
        FROM canonical_activity_training
        WHERE cast(started_at_utc AS DATE) <= $endDate
        ORDER BY started_at_utc DESC
        LIMIT 12
      `, { endDate: options.endDate });
    const status = await this.repository.status();
    const coverage = await this.repository.coverage();

    return {
      generatedAt: new Date().toISOString(),
      period: { startDate, endDate: options.endDate, days: options.days },
      health,
      training: { weeks: weeklyTraining },
      activities: recentActivities,
      status,
      coverage,
      caveats: [
        'Dashboard values are read from Catence canonical daily-health and activity projections.',
        'Missing metrics or periods are returned as null or absent rows and are never estimated for visualization.',
      ],
    };
  }
}
