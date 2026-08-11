import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../../contracts/runtime.js';
import { ensurePaths } from '../../core/runtime/configuration.js';
import { importRecord } from '../ingestion/importer.js';
import { CatenceDatabase } from '../storage/database.js';

const DEMO_MARKER = 'demo-store.json';
const DEMO_FORMAT_VERSION = 1;

export type DemoStoreMetadata = {
  formatVersion: number;
  generated: true;
  seed: number;
  days: number;
  startDate: string;
  endDate: string;
  createdAt: string;
};

export type CreateDemoStoreOptions = {
  /** Keep the demo small enough for fast evaluation while still supporting trends. */
  days?: number;
  seed?: number;
  /** Primarily useful for deterministic tests and documentation screenshots. */
  endDate?: string;
};

function markerPath(paths: CatencePaths): string {
  return path.join(paths.root, DEMO_MARKER);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoDate(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function rounded(value: number, decimals = 0): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00.000Z`));
}

async function hasDirectoryContents(directory: string): Promise<boolean> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  return entries.length > 0;
}

export async function demoStoreMetadata(paths: CatencePaths): Promise<DemoStoreMetadata | null> {
  const contents = await readFile(markerPath(paths), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!contents) return null;
  try {
    const value = JSON.parse(contents) as Partial<DemoStoreMetadata>;
    if (value.formatVersion !== DEMO_FORMAT_VERSION || value.generated !== true || !Number.isInteger(value.seed) || !Number.isInteger(value.days)
      || typeof value.startDate !== 'string' || typeof value.endDate !== 'string' || typeof value.createdAt !== 'string') return null;
    return value as DemoStoreMetadata;
  } catch {
    return null;
  }
}

/**
 * Create generated data only in a fresh directory or one already marked as a
 * Catence demo.  A real data directory is never opened for mutation here.
 */
export async function createDemoStore(paths: CatencePaths, options: CreateDemoStoreOptions = {}): Promise<Record<string, unknown>> {
  const days = options.days ?? 90;
  const seed = options.seed ?? 17;
  const endDate = options.endDate ?? isoDate(new Date());
  if (!Number.isInteger(days) || days < 14 || days > 365) throw new Error('Demo days must be an integer between 14 and 365.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error('Demo seed must be an integer between 0 and 2147483647.');
  if (!validDate(endDate)) throw new Error('Demo endDate must use YYYY-MM-DD.');

  const existing = await demoStoreMetadata(paths);
  if (!existing && await hasDirectoryContents(paths.root)) {
    throw new Error(`Refusing to overwrite ${paths.root}: it is not a Catence demo store. Choose an empty --data-dir.`);
  }
  if (existsSync(paths.database) && existing) {
    return {
      created: false,
      dataDir: paths.root,
      demoStore: existing,
      message: 'Existing generated Catence demo store is ready. Its values are synthetic, not personal measurements.',
    };
  }

  const startDate = addDays(endDate, -(days - 1));
  const random = seededRandom(seed);
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  try {
    const runId = await database.beginRun('garmin', startDate);
    let previousTrainingLoad = 0;
    for (let offset = 0; offset < days; offset++) {
      const date = addDays(startDate, offset);
      const weeklyLoad = [0, 26, 58, 76, 18, 54, 118][offset % 7]!;
      const illness = offset >= Math.floor(days * 0.48) && offset < Math.floor(days * 0.48) + 6;
      const recovery = Math.sin(offset / 5) * 0.7 + (random() - 0.5) * 0.45 - (illness ? 1.8 : 0);
      const trainingLoad = Math.max(0, weeklyLoad + (random() - 0.5) * 12 - (illness ? 28 : 0));
      const restingHeartRate = rounded(52 - recovery * 3.8 + previousTrainingLoad * 0.045 + (random() - 0.5) * 1.3);
      const hrv = rounded(53 + recovery * 8.5 - previousTrainingLoad * 0.025 + (random() - 0.5) * 2.5);
      const sleepScore = rounded(76 + recovery * 9 - previousTrainingLoad * 0.025 + (random() - 0.5) * 4);
      const stress = rounded(34 - recovery * 8 + previousTrainingLoad * 0.04 + (random() - 0.5) * 4);
      const bodyBattery = rounded(59 + recovery * 17 - previousTrainingLoad * 0.04 + (random() - 0.5) * 5);
      const sleepIsMissing = offset % 23 === 8 || offset % 31 === 12;
      const wellnessPayload: Record<string, unknown> = {
        calendarDate: date,
        restingHeartRate,
        hrvSDNN: hrv,
        sleepTimeSeconds: rounded(7.25 * 3_600 + recovery * 450 + (random() - 0.5) * 420),
        averageStressLevel: stress,
        bodyBattery,
        trainingReadinessScore: rounded(62 + recovery * 16 - previousTrainingLoad * 0.04),
        averageSpO2: rounded(96.4 + recovery * 0.25 + (random() - 0.5) * 0.3, 1),
        totalSteps: rounded(8_300 + (random() - 0.5) * 3_000),
      };
      if (!sleepIsMissing) wellnessPayload.sleepScore = sleepScore;
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'daily_health', remoteId: `demo-wellness:${date}`,
        parentRemoteId: null, occurredOn: date, sourceUpdatedAt: null, rawObjectHash: hash(`demo-wellness:${seed}:${date}`), payload: wellnessPayload, extension: { generated: true },
      });
      if (trainingLoad >= 12) {
        await importRecord(database, runId, {
          kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: `demo-activity:${date}`,
          parentRemoteId: null, occurredOn: date, sourceUpdatedAt: null, rawObjectHash: hash(`demo-activity:${seed}:${date}`), extension: { generated: true },
          payload: {
            activityId: `demo-activity:${date}`,
            startTimeGMT: `${date}T10:00:00Z`,
            activityType: offset % 3 === 0 ? 'running' : 'road_biking',
            activityName: offset % 3 === 0 ? 'Generated endurance run' : 'Generated endurance ride',
            distance: rounded(5_000 + trainingLoad * 360),
            duration: rounded(1_800 + trainingLoad * 18),
            activityTrainingLoad: rounded(trainingLoad, 1),
            averageHR: rounded(132 + trainingLoad * 0.12),
          },
        });
      }
      previousTrainingLoad = trainingLoad;
    }
    await database.finishRun(runId);
  } finally {
    await database.close();
  }

  const metadata: DemoStoreMetadata = {
    formatVersion: DEMO_FORMAT_VERSION,
    generated: true,
    seed,
    days,
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
  };
  await writeFile(markerPath(paths), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    created: true,
    dataDir: paths.root,
    demoStore: metadata,
    message: 'Generated Catence demo store is ready. Its values are synthetic, not personal measurements.',
    exampleQuestions: [
      'Use wellness_correlate with metricA training_load, metricB resting_hr_bpm, and scanLags true.',
      'Use wellness_anomalies to find the deliberately generated multi-metric recovery disruption.',
      'Use wellness_coverage to inspect intentionally missing sleep-score dates.',
    ],
  };
}
