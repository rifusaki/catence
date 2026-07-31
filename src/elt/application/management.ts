import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { CatencePaths } from '../../contracts/runtime.js';
import { buildRetrievalIndex } from '../../core/retrieval/index.js';
import { defaultFromDate, ensurePaths, requireIntervalsConfig } from '../../core/runtime/configuration.js';
import { importJsonl } from '../ingestion/importer.js';
import { IntervalsExtractor } from '../ingestion/providers/intervals.js';
import { completeStravaAuthorization, disconnectStrava, getStravaAuthorizationUrl, syncStravaGear } from '../ingestion/providers/strava/service.js';
import { setManualActivityLink, unlinkActivitySource } from '../normalization/activities/linking.js';
import { CatenceDatabase } from '../storage/database.js';
import { withDataWriteLock } from '../storage/write-lock.js';

const execFileAsync = promisify(execFile);

type SyncProviderChoice = 'intervals' | 'garmin';
export type ProviderChoice = SyncProviderChoice | 'strava' | 'all';
type CursorSource = 'cursor' | 'bootstrap' | 'initial' | 'explicit';
type SyncResult = {
  runId: string;
  provider: SyncProviderChoice;
  fromDate: string;
  dailyFromDate: string;
  activityFromDate: string;
  toDate: string;
  dailyCursorSource: CursorSource;
  activityCursorSource: CursorSource;
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

async function syncProvider(database: CatenceDatabase, paths: CatencePaths, provider: SyncProviderChoice, options: { explicitFrom?: string; toDate: string; advanceCursor: boolean }): Promise<SyncResult> {
  const explicitWindow = options.explicitFrom ? { fromDate: options.explicitFrom, toDate: options.toDate, source: 'explicit' as const } : null;
  const dailyWindow = explicitWindow ?? await database.resolveIncrementalWindow(provider, 'daily', options.toDate, defaultFromDate(), 3);
  const activityWindow = explicitWindow ?? await database.resolveIncrementalWindow(provider, 'activities', options.toDate, defaultFromDate(), 14);
  const fromDate = dailyWindow.fromDate < activityWindow.fromDate ? dailyWindow.fromDate : activityWindow.fromDate;
  const runId = await database.beginRun(provider, fromDate);
  let extractionStarted = false;
  try {
    if (provider === 'intervals') {
      const config = requireIntervalsConfig();
      extractionStarted = true;
      await new IntervalsExtractor(database, paths, config.apiKey, config.athleteId).sync(runId, dailyWindow.fromDate, activityWindow.fromDate, options.toDate);
    } else {
      const output = path.join(paths.staging, 'garmin', `${runId}.jsonl`);
      const knownActivities = path.join(paths.staging, 'garmin', `${runId}.known-activities.json`);
      await mkdir(path.dirname(knownActivities), { recursive: true });
      await writeFile(knownActivities, JSON.stringify(await database.knownActivitySummaryHashes('garmin')));
      extractionStarted = true;
      await execFileAsync('uv', ['run', 'python', '-m', 'python.catence.providers.garmin.cli', '--from', fromDate, '--daily-from', dailyWindow.fromDate, '--activity-from', activityWindow.fromDate, '--to', options.toDate, '--data-dir', paths.root, '--output', output, '--run-id', runId, '--known-activities', knownActivities], {
        cwd: packageRoot(),
        env: { ...process.env, UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? path.join(paths.root, 'python-venv') },
      });
      if (!existsSync(output)) throw new Error('Garmin staging worker completed without writing a JSONL manifest.');
      await importJsonl(database, runId, output);
    }
  } catch (error) {
    await database.addError(runId, provider, 'sync', null, error instanceof Error ? error.message : String(error), true);
  } finally {
    await database.finishRun(runId);
  }
  if (options.advanceCursor && !options.explicitFrom && extractionStarted) {
    await database.advanceIncrementalCursor(provider, 'daily', runId, options.toDate, 3);
    await database.advanceIncrementalCursor(provider, 'activities', runId, options.toDate, 14);
  }
  return { runId, provider, fromDate, dailyFromDate: dailyWindow.fromDate, activityFromDate: activityWindow.fromDate, toDate: options.toDate, dailyCursorSource: dailyWindow.source, activityCursorSource: activityWindow.source };
}

export async function initializeDataStore(paths: CatencePaths): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  await database.close();
  return { dataDir: paths.root, database: paths.database, message: 'Catence data store is ready. Run sync to import provider data.' };
}

export async function syncData(paths: CatencePaths, provider: ProviderChoice, explicitFrom?: string, advanceCursor = true): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  if (provider === 'strava') return { provider, result: await syncStravaGear(paths) };
  const database = await CatenceDatabase.open(paths);
  try {
    const providers: SyncProviderChoice[] = provider === 'all' ? ['intervals', 'garmin'] : [provider];
    const toDate = new Date().toISOString().slice(0, 10);
    const runs: SyncResult[] = [];
    for (const source of providers) runs.push(await syncProvider(database, paths, source, { explicitFrom, toDate, advanceCursor }));
    return { runIds: runs.map((run) => run.runId), runs };
  } finally {
    await database.close();
  }
}

export async function retryDataSync(paths: CatencePaths, previousRunId: string): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  try {
    const previous = await database.getRun(previousRunId);
    if (!previous) throw new Error(`No sync run found for ${previousRunId}.`);
    if (previous.provider === 'strava') throw new Error('Retry Strava gear sync with `catence-data sync --provider strava`.');
    const run = await syncProvider(database, paths, previous.provider, { explicitFrom: previous.from_date, toDate: new Date().toISOString().slice(0, 10), advanceCursor: false });
    return { retriedRun: previousRunId, runId: run.runId, run };
  } finally {
    await database.close();
  }
}

export async function connectStrava(paths: CatencePaths, code: string | undefined, redirectUri: string): Promise<unknown> {
  return code ? completeStravaAuthorization(paths, code, redirectUri) : getStravaAuthorizationUrl(paths, redirectUri);
}

export async function disconnectStravaAccount(paths: CatencePaths): Promise<{ provider: 'strava'; disconnected: true }> {
  await disconnectStrava(paths);
  return { provider: 'strava', disconnected: true };
}

export async function linkActivity(paths: CatencePaths, source: string, activity: string): Promise<Record<string, string>> {
  await ensurePaths(paths);
  await withDataWriteLock(paths, async () => {
    const database = await CatenceDatabase.open(paths);
    try { await setManualActivityLink(database, source, activity); } finally { await database.close(); }
  });
  return { source, activity, method: 'manual' };
}

export async function unlinkActivity(paths: CatencePaths, source: string): Promise<Record<string, string>> {
  await ensurePaths(paths);
  await withDataWriteLock(paths, async () => {
    const database = await CatenceDatabase.open(paths);
    try { await unlinkActivitySource(database, source); } finally { await database.close(); }
  });
  return { source, method: 'source' };
}

export async function dataStatus(paths: CatencePaths): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  try { return await database.status(); } finally { await database.close(); }
}

export async function rebuildRetrievalIndex(paths: CatencePaths): Promise<Record<string, unknown>> {
  if (!existsSync(paths.database)) throw new Error('No Catence database exists yet. Complete a sync before building the retrieval index.');
  const database = await CatenceDatabase.open(paths);
  try { return await buildRetrievalIndex(database); } finally { await database.close(); }
}
