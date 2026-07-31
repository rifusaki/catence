import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../contracts/runtime.js';
import { sqlString } from './storage/sql.js';
import type { CatenceDatabase } from './storage/database.js';

export type ActivitySample = {
  activity_source_id: string;
  timestamp_utc: string | null;
  elapsed_s: number | null;
  distance_m: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude_m: number | null;
  heart_rate_bpm: number | null;
  power_w: number | null;
  cadence_rpm: number | null;
  speed_mps: number | null;
  temperature_c: number | null;
  grade_pct: number | null;
  extras_json: string;
};

const knownColumns: Record<string, keyof Omit<ActivitySample, 'activity_source_id' | 'extras_json'>> = {
  time: 'elapsed_s', elapsed_time: 'elapsed_s', elapsed_s: 'elapsed_s', distance: 'distance_m', lat: 'latitude', latitude: 'latitude',
  lng: 'longitude', lon: 'longitude', longitude: 'longitude', altitude: 'altitude_m', elevation: 'altitude_m', heartrate: 'heart_rate_bpm',
  heart_rate: 'heart_rate_bpm', hr: 'heart_rate_bpm', watts: 'power_w', power: 'power_w', cadence: 'cadence_rpm', velocity_smooth: 'speed_mps',
  speed: 'speed_mps', temp: 'temperature_c', temperature: 'temperature_c', grade_smooth: 'grade_pct', grade: 'grade_pct',
};

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function intervalsStreamsToSamples(activitySourceId: string, streams: Array<Record<string, unknown>>, startAt: string | null): ActivitySample[] {
  const arrays = new Map<string, unknown[]>();
  for (const stream of streams) {
    const name = typeof stream.type === 'string' ? stream.type : typeof stream.name === 'string' ? stream.name : null;
    const values = Array.isArray(stream.data) ? stream.data : null;
    if (name && values) arrays.set(name, values);
  }
  const count = Math.max(0, ...[...arrays.values()].map((values) => values.length));
  const origin = startAt ? Date.parse(startAt) : Number.NaN;
  return Array.from({ length: count }, (_, index) => {
    const extras: Record<string, unknown> = {};
    const sample: ActivitySample = {
      activity_source_id: activitySourceId, timestamp_utc: Number.isFinite(origin) ? new Date(origin + (numeric(arrays.get('time')?.[index]) ?? index) * 1000).toISOString() : null,
      elapsed_s: null, distance_m: null, latitude: null, longitude: null, altitude_m: null, heart_rate_bpm: null, power_w: null,
      cadence_rpm: null, speed_mps: null, temperature_c: null, grade_pct: null, extras_json: '{}',
    };
    for (const [name, values] of arrays) {
      const value = values[index];
      const column = knownColumns[name];
      if (column) (sample as Record<string, string | number | null>)[column] = numeric(value);
      else extras[name] = value;
    }
    sample.extras_json = JSON.stringify(extras);
    return sample;
  });
}

export async function writeParquetSamples(database: CatenceDatabase, paths: CatencePaths, provider: 'intervals' | 'garmin', activityRemoteId: string, startDate: string, samples: ActivitySample[]): Promise<{ relativePath: string; contentHash: string; columns: string[] }> {
  const activitySourceId = `${provider}:${activityRemoteId}`;
  const year = startDate.slice(0, 4) || 'unknown';
  const month = startDate.slice(5, 7) || 'unknown';
  const directory = path.join(paths.lake, `provider=${provider}`, `year=${year}`, `month=${month}`);
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(paths.staging, `${provider}-${activityRemoteId}-${process.pid}.ndjson`);
  await writeFile(jsonPath, samples.map((sample) => JSON.stringify(sample)).join('\n'));
  const target = path.join(directory, `activity=${activityRemoteId}.parquet`);
  const temporary = `${target}.${process.pid}.tmp`;
  await database.run(`COPY (SELECT * FROM read_ndjson_auto(${sqlString(jsonPath)})) TO ${sqlString(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  await rename(temporary, target);
  const contentHash = createHash('sha256').update(await (await import('node:fs/promises')).readFile(target)).digest('hex');
  return {
    relativePath: path.relative(paths.root, target),
    contentHash,
    columns: ['activity_source_id', 'timestamp_utc', 'elapsed_s', 'distance_m', 'latitude', 'longitude', 'altitude_m', 'heart_rate_bpm', 'power_w', 'cadence_rpm', 'speed_mps', 'temperature_c', 'grade_pct', 'extras_json'],
  };
}
