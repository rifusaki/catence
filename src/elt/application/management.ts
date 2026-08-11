import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
type DateWindow = { fromDate: string; toDate: string; source: CursorSource };
type SyncResult = {
  runId: string | null;
  provider: SyncProviderChoice;
  fromDate: string | null;
  dailyFromDate: string | null;
  dailyToDate: string | null;
  activityFromDate: string | null;
  activityToDate: string | null;
  toDate: string;
  dailyCursorSource: CursorSource | null;
  activityCursorSource: CursorSource | null;
  refreshedActivities: boolean;
  skipped: boolean;
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

async function syncProvider(database: CatenceDatabase, paths: CatencePaths, provider: SyncProviderChoice, options: { explicitFrom?: string; toDate: string; advanceCursor: boolean; refreshActivities: boolean; backfill: boolean }): Promise<SyncResult> {
  const explicitWindow: DateWindow | null = options.explicitFrom ? { fromDate: options.explicitFrom, toDate: options.toDate, source: 'explicit' } : null;
  const uncoveredExplicitWindow = async (cursorName: 'daily' | 'activities'): Promise<DateWindow | null> => {
    if (!explicitWindow) return null;
    if (!options.backfill) return explicitWindow;
    const window = await database.resolveBackfillWindow(provider, cursorName, explicitWindow.fromDate, explicitWindow.toDate, options.refreshActivities);
    return window ? { ...window, source: 'explicit' } : null;
  };
  const dailyWindow = explicitWindow ? await uncoveredExplicitWindow('daily') : await database.resolveIncrementalWindow(provider, 'daily', options.toDate, defaultFromDate(), 3);
  const activityWindow = explicitWindow ? await uncoveredExplicitWindow('activities') : await database.resolveIncrementalWindow(provider, 'activities', options.toDate, defaultFromDate(), 14);
  const hasProviderWork = provider === 'intervals' ? activityWindow !== null : dailyWindow !== null || activityWindow !== null;
  if (!hasProviderWork) {
    return {
      runId: null, provider, fromDate: null,
      dailyFromDate: dailyWindow?.fromDate ?? null, dailyToDate: dailyWindow?.toDate ?? null,
      activityFromDate: activityWindow?.fromDate ?? null, activityToDate: activityWindow?.toDate ?? null,
      toDate: options.toDate, dailyCursorSource: dailyWindow?.source ?? null, activityCursorSource: activityWindow?.source ?? null,
      refreshedActivities: provider === 'garmin' && options.refreshActivities, skipped: true,
    };
  }
  const fromDate = [dailyWindow?.fromDate, activityWindow?.fromDate].filter((date): date is string => Boolean(date)).sort()[0]!;
  const runId = await database.beginRun(provider, fromDate);
  let extractionStarted = false;
  try {
    if (provider === 'intervals') {
      const config = requireIntervalsConfig();
      extractionStarted = true;
      await new IntervalsExtractor(database, paths, config.apiKey, config.athleteId).sync(runId, activityWindow, !options.backfill || options.refreshActivities);
    } else {
      const output = path.join(paths.staging, 'garmin', `${runId}.jsonl`);
      const knownActivities = path.join(paths.staging, 'garmin', `${runId}.known-activities.json`);
      await mkdir(path.dirname(knownActivities), { recursive: true });
      // An explicit refresh intentionally provides no known hashes, causing
      // the staging worker to re-fetch Garmin activity details, files, and
      // streams even when the list-summary hash is unchanged.
      await writeFile(knownActivities, JSON.stringify(options.refreshActivities ? {} : await database.knownActivitySummaryHashes('garmin')));
      extractionStarted = true;
      const arguments_ = ['run', 'python', '-m', 'python.catence.providers.garmin.cli', '--from', fromDate, '--to', options.toDate, '--data-dir', paths.root, '--output', output, '--run-id', runId, '--known-activities', knownActivities];
      if (dailyWindow) arguments_.push('--daily-from', dailyWindow.fromDate, '--daily-to', dailyWindow.toDate);
      else arguments_.push('--skip-daily');
      if (activityWindow) arguments_.push('--activity-from', activityWindow.fromDate, '--activity-to', activityWindow.toDate);
      else arguments_.push('--skip-activities');
      if (options.backfill && !options.refreshActivities) arguments_.push('--historical-only');
      await execFileAsync('uv', arguments_, {
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
  return {
    runId, provider, fromDate,
    dailyFromDate: dailyWindow?.fromDate ?? null, dailyToDate: dailyWindow?.toDate ?? null,
    activityFromDate: activityWindow?.fromDate ?? null, activityToDate: activityWindow?.toDate ?? null,
    toDate: options.toDate, dailyCursorSource: dailyWindow?.source ?? null, activityCursorSource: activityWindow?.source ?? null,
    refreshedActivities: provider === 'garmin' && options.refreshActivities, skipped: false,
  };
}

export async function initializeDataStore(paths: CatencePaths): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  await database.close();
  return { dataDir: paths.root, database: paths.database, message: 'Catence data store is ready. Run sync to import provider data.' };
}

export async function syncData(paths: CatencePaths, provider: ProviderChoice, explicitFrom?: string, advanceCursor = true, refreshActivities = false, backfill = false): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  if (provider === 'strava') return { provider, result: await syncStravaGear(paths) };
  const database = await CatenceDatabase.open(paths);
  try {
    const providers: SyncProviderChoice[] = provider === 'all' ? ['intervals', 'garmin'] : [provider];
    const toDate = new Date().toISOString().slice(0, 10);
    const runs: SyncResult[] = [];
    for (const source of providers) runs.push(await syncProvider(database, paths, source, { explicitFrom, toDate, advanceCursor, refreshActivities, backfill }));
    return { runIds: runs.flatMap((run) => run.runId ? [run.runId] : []), runs };
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
    const run = await syncProvider(database, paths, previous.provider, { explicitFrom: previous.from_date, toDate: new Date().toISOString().slice(0, 10), advanceCursor: false, refreshActivities: false, backfill: false });
    return { retriedRun: previousRunId, runId: run.runId, run };
  } finally {
    await database.close();
  }
}

export async function connectStrava(paths: CatencePaths, code: string | undefined, redirectUri: string): Promise<unknown> {
  return code ? completeStravaAuthorization(paths, code, redirectUri) : getStravaAuthorizationUrl(paths, redirectUri);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Validate a local OAuth return address before opening a callback listener. */
export function loopbackStravaRedirect(redirectUri: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('--redirect-uri must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.port) {
    throw new Error('--callback requires an http loopback --redirect-uri with an explicit port.');
  }
  return parsed;
}

type StravaCallbackResult = { code: string; state: string | null };

function readStravaCallback(requestUrl: string | undefined, callback: URL): StravaCallbackResult {
  const received = new URL(requestUrl ?? '/', callback);
  if (received.pathname !== callback.pathname) throw new Error('Strava returned to an unexpected callback path.');
  const error = received.searchParams.get('error');
  if (error) throw new Error(`Strava authorization was declined or failed: ${error}.`);
  const code = received.searchParams.get('code');
  if (!code) throw new Error('Strava callback did not include an authorization code.');
  return { code, state: received.searchParams.get('state') };
}

function callbackPage(response: import('node:http').ServerResponse, success: boolean): void {
  response.writeHead(success ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(success
    ? '<!doctype html><title>Catence connected</title><p>Strava is connected to Catence. You can close this tab.</p>'
    : '<!doctype html><title>Catence authorization failed</title><p>Strava authorization did not complete. Return to the terminal for details.</p>');
}

/**
 * Complete Strava OAuth through a short-lived loopback callback listener.
 *
 * The authorization URL is emitted through the caller so the CLI can keep
 * stdout machine-readable for the final connection result.
 */
export async function connectStravaWithCallback(
  paths: CatencePaths,
  redirectUri: string,
  onAuthorizationUrl: (url: string) => void,
  timeoutMs = 300_000,
): Promise<unknown> {
  const callback = loopbackStravaRedirect(redirectUri);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('OAuth callback timeout must be at least one second.');
  const expectedState = randomUUID();
  const listener = createServer();
  const callbackResult = new Promise<StravaCallbackResult>((resolve, reject) => {
    listener.once('error', reject);
    listener.on('request', (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      try {
        const result = readStravaCallback(request.url, callback);
        if (result.state !== expectedState) throw new Error('Strava callback state did not match this authorization request.');
        callbackPage(response, true);
        resolve(result);
      } catch (error) {
        callbackPage(response, false);
        reject(error);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(Number(callback.port), callback.hostname.replace(/^\[|\]$/g, ''), () => {
        listener.off('error', reject);
        resolve();
      });
    });
    const authorization = await getStravaAuthorizationUrl(paths, callback.toString());
    if (!authorization.authorizationUrl) throw new Error('Strava did not return an authorization URL.');
    const authorizationUrl = new URL(authorization.authorizationUrl);
    authorizationUrl.searchParams.set('state', expectedState);
    onAuthorizationUrl(authorizationUrl.toString());
    const timed = Promise.race<StravaCallbackResult>([
      callbackResult,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the Strava callback.')), timeoutMs)),
    ]);
    const { code } = await timed;
    return completeStravaAuthorization(paths, code, callback.toString());
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
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
