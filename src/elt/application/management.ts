import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatencePaths } from '../../contracts/runtime.js';
import type { Provider } from '../../contracts/staging.js';
import { normalizeProgress, STALE_RUN_TIMEOUT_MS, type SyncProgressSnapshot, type SyncProgressState, type SyncStage } from '../../contracts/progress.js';
import { buildRetrievalIndex } from '../../core/retrieval/index.js';
import { defaultFromDate, ensurePaths, requireIntervalsConfig } from '../../core/runtime/configuration.js';
import { createSyncLogger, type SyncLogger } from '../../core/logging.js';
import { athleteProviderEnvironment } from '../../core/runtime/secrets.js';
import { importJsonl } from '../ingestion/importer.js';
import { IntervalsExtractor } from '../ingestion/providers/intervals.js';
import { completeStravaAuthorization, disconnectStrava, getStravaAuthorizationUrl, syncStravaGear } from '../ingestion/providers/strava/service.js';
import { setManualActivityLink, unlinkActivitySource } from '../normalization/activities/linking.js';
import { importSourceEntity } from '../normalization/normalizers.js';
import { CatenceDatabase, openReadOnlyRepository, ReadOnlyDatabaseError } from '../storage/database.js';
import { mergeProgress, ProgressPump, readRunningProgress, removeProgressSidecar } from '../storage/progress-sidecar.js';
import { withDataWriteLock } from '../storage/write-lock.js';

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

type GarminWorkerOutcome = { code: number | null; signal: NodeJS.Signals | null };

function baseProgress(runId: string, provider: string, stage: SyncStage): SyncProgressState {
  return {
    runId, provider, stage, currentStep: null,
    completedUnits: 0, totalUnits: null, percentComplete: 0, elapsedSeconds: 0,
    estimatedRemainingSeconds: null, heartbeatAt: new Date().toISOString(),
  };
}

/**
 * Run the Garmin staging worker with streamed stdout/stderr so progress and
 * errors surface in real time instead of buffering until the child exits.
 * Progress NDJSON lines (kind 'progress') are normalized and persisted as
 * throttled heartbeats; other output is forwarded to the sync logger.
 */
function runGarminWorker(
  runId: string,
  arguments_: string[],
  environment: { cwd: string; env: NodeJS.ProcessEnv },
  pump: ProgressPump,
  log: SyncLogger,
  onInterruptReady: (kill: () => void) => void,
): Promise<GarminWorkerOutcome> {
  return new Promise((resolve) => {
    const child = spawn('uv', arguments_, { ...environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    onInterruptReady(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGKILL');
      }, 10_000);
      killTimer.unref();
    });
    const buffer = (stream: NodeJS.ReadableStream, sink: (line: string) => void): void => {
      let pending = '';
      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) sink(line);
        }
      });
      stream.on('end', () => {
        const line = pending.trim();
        if (line) sink(line);
      });
    };
    buffer(child.stdout, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.info(`[garmin] ${line}`);
        return;
      }
      if (typeof parsed === 'object' && parsed !== null && (parsed as { kind?: unknown }).kind === 'progress') {
        const state = normalizeProgress(parsed);
        if (state) pump.publish(state);
        return;
      }
      log.info(`[garmin] ${line}`);
    });
    buffer(child.stderr, (line) => log.error(`[garmin] ${line}`));
    child.on('error', (error) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 1, signal: null });
      log.error('Garmin staging worker could not be started', { runId, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) pump.setStageImporting();
      resolve({ code, signal });
    });
  });
}

/**
 * Trap termination signals for the duration of a sync run so an interrupted
 * run is marked 'interrupted' in sync_runs instead of being left as a zombie
 * 'running' row. The process exit code mirrors the received signal.
 */async function runWithInterruptGuard(
  runId: string,
  database: CatenceDatabase,
  onInterrupt: () => void,
  state: { interrupted: boolean },
  work: () => Promise<void>,
): Promise<void> {
  let exitCode = 0;
  const handler = (signal: NodeJS.Signals): void => {
    if (state.interrupted) return;
    state.interrupted = true;
    exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
    void database.markRunInterrupted(runId).catch(() => undefined);
    try {
      onInterrupt();
    } catch {
      // The child may not exist yet; the run is still marked interrupted.
    }
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  process.once('SIGHUP', handler);
  try {
    await work();
  } finally {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
    process.removeListener('SIGHUP', handler);
    if (state.interrupted) process.exitCode = exitCode;
  }
}

async function syncProvider(database: CatenceDatabase, paths: CatencePaths, provider: SyncProviderChoice, options: { explicitFrom?: string; toDate: string; advanceCursor: boolean; refreshActivities: boolean; backfill: boolean }, log: SyncLogger): Promise<SyncResult> {
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
    log.debug('No uncovered work; skipping provider', { provider, daily: dailyWindow ?? null, activities: activityWindow ?? null });
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
  log.info('Starting sync run', {
    runId, provider, fromDate, toDate: options.toDate,
    dailyFrom: dailyWindow?.fromDate ?? null, dailyTo: dailyWindow?.toDate ?? null,
    activityFrom: activityWindow?.fromDate ?? null, activityTo: activityWindow?.toDate ?? null,
    backfill: options.backfill, refreshActivities: options.refreshActivities,
  });
  let extractionStarted = false;
  const guard: { interrupted: boolean } = { interrupted: false };
  const pump = new ProgressPump(runId, provider, { database, paths, log });
  pump.start();
  try {
    if (provider === 'intervals') {
      const environment = await athleteProviderEnvironment(paths);
      const config = requireIntervalsConfig(environment);
      extractionStarted = true;
      pump.setStage('intervals');
      await runWithInterruptGuard(runId, database, () => undefined, guard, async () => {
        await new IntervalsExtractor(database, paths, config.apiKey, config.athleteId, log).sync(runId, activityWindow, !options.backfill || options.refreshActivities);
      });
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
      let interruptChild: (() => void) | null = null;
      await runWithInterruptGuard(runId, database, () => interruptChild?.(), guard, async () => {
        const outcome = await runGarminWorker(
          runId,
          arguments_,
          {
            cwd: packageRoot(),
            env: { ...(await athleteProviderEnvironment(paths)), UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? path.join(paths.root, 'python-venv') },
          },
          pump,
          log,
          (kill) => { interruptChild = kill; },
        );
        if (!guard.interrupted && outcome.code !== 0) {
          throw new Error(`Garmin staging worker exited with code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''}.`);
        }
      });
      if (!guard.interrupted) {
        if (!existsSync(output)) throw new Error('Garmin staging worker completed without writing a JSONL manifest.');
        await importJsonl(database, runId, output, log);
      }
    }
  } catch (error) {
    if (!guard.interrupted) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Sync run failed', { runId, provider, error: message, stack: error instanceof Error ? error.stack : undefined });
      await database.addError(runId, provider, 'sync', null, message, true);
      await database.heartbeatRun(runId, baseProgress(runId, provider, 'failed')).catch(() => undefined);
    }
  } finally {
    pump.stop();
    if (guard.interrupted) {
      await database.markRunInterrupted(runId);
      log.warn('Sync run interrupted', { runId, provider });
    } else {
      await database.finishRun(runId);
      pump.publishFinal(baseProgress(runId, provider, 'completed'));
    }
    await removeProgressSidecar(paths, runId).catch(() => undefined);
    const [run] = await database.rows<{ status: string; error_count: number }>(
      'SELECT status, error_count FROM sync_runs WHERE run_id = $runId',
      { runId },
    );
    log.info('Sync run finished', { runId, provider, status: run?.status ?? 'unknown', errorCount: run?.error_count ?? 0 });
  }
  if (!guard.interrupted && options.advanceCursor && !options.explicitFrom && extractionStarted) {
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
  const log = createSyncLogger(paths);
  try {
    const timedOutRuns = await database.interruptStaleSyncRuns(STALE_RUN_TIMEOUT_MS);
    if (timedOutRuns.runIds.length > 0) {
      log.warn('Marked stale sync runs as timed out', { runIds: timedOutRuns.runIds, timeoutMs: STALE_RUN_TIMEOUT_MS });
    }
    for (const runId of timedOutRuns.runIds) {
      await removeProgressSidecar(paths, runId).catch(() => undefined);
    }
    const providers: SyncProviderChoice[] = provider === 'all' ? ['intervals', 'garmin'] : [provider];
    const toDate = new Date().toISOString().slice(0, 10);
    const runs: SyncResult[] = [];
    for (const source of providers) runs.push(await syncProvider(database, paths, source, { explicitFrom, toDate, advanceCursor, refreshActivities, backfill }, log));
    const executedRuns = runs.filter((run) => !run.skipped);
    if (executedRuns.length > 0) {
      const index = await buildRetrievalIndex(database);
      log.info('Rebuilt retrieval index after sync', { documents: index.documents, mode: index.mode, watermark: index.watermark });
    }
    return { runIds: runs.flatMap((run) => run.runId ? [run.runId] : []), runs, timedOutRuns: timedOutRuns.runIds };
  } finally {
    await database.close();
  }
}

export async function retryDataSync(paths: CatencePaths, previousRunId: string): Promise<Record<string, unknown>> {
  await ensurePaths(paths);
  const database = await CatenceDatabase.open(paths);
  try {
    await database.interruptStaleSyncRuns(STALE_RUN_TIMEOUT_MS);
    const previous = await database.getRun(previousRunId);
    if (!previous) throw new Error(`No sync run found for ${previousRunId}.`);
    if (previous.provider === 'strava') throw new Error('Retry Strava gear sync with `catence-data sync --provider strava`.');
    const log = createSyncLogger(paths);
    const run = await syncProvider(database, paths, previous.provider, { explicitFrom: previous.from_date, toDate: new Date().toISOString().slice(0, 10), advanceCursor: false, refreshActivities: false, backfill: false }, log);
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

export async function syncProgress(paths: CatencePaths): Promise<SyncProgressSnapshot> {
  await ensurePaths(paths);
  // Live progress must stay readable while a sync run holds the single-writer
  // DuckDB lock, so the running set comes from sidecar heartbeat files first.
  const sidecars = await readRunningProgress(paths);
  let dbRunning: SyncProgressState[] = [];
  let dbRecent: SyncProgressState[] = [];
  try {
    const repository = await openReadOnlyRepository(paths);
    try {
      const snapshot = await repository.progress();
      dbRunning = snapshot.running;
      dbRecent = snapshot.recent;
    } finally {
      await repository.close();
    }
  } catch (error) {
    if (!(error instanceof ReadOnlyDatabaseError)) throw error;
  }
  return mergeProgress(dbRunning, dbRecent, sidecars);
}

export async function rebuildRetrievalIndex(paths: CatencePaths): Promise<Record<string, unknown>> {
  if (!existsSync(paths.database)) throw new Error('No Catence database exists yet. Complete a sync before building the retrieval index.');
  const database = await CatenceDatabase.open(paths);
  try { return await buildRetrievalIndex(database); } finally { await database.close(); }
}

export async function importStagedFile(paths: CatencePaths, provider: ProviderChoice, filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(paths.database)) throw new Error('No Catence database exists yet. Complete a sync before importing staged records.');
  if (!existsSync(filePath)) throw new Error(`Staging file not found: ${filePath}`);
  const database = await CatenceDatabase.open(paths);
  try {
    const runId = randomUUID();
    const importedRecords = await importJsonl(database, runId, filePath);
    return { runId, provider, importedRecords };
  } finally {
    await database.close();
  }
}

export async function resolveExtractionErrors(
  paths: CatencePaths,
  opts: { runIds?: string[]; provider?: string; before?: string; all?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (!existsSync(paths.database)) throw new Error('No Catence database exists yet.');
  const database = await CatenceDatabase.open(paths);
  try {
    const resolved = await database.resolveErrors({
      runIds: opts.runIds,
      provider: opts.provider as Provider | undefined,
      before: opts.before,
      all: opts.all,
    });
    return { resolvedErrors: resolved };
  } finally {
    await database.close();
  }
}

type ReimportRow = {
  provider: string; entity_type: string; remote_id: string; parent_remote_id: string | null;
  occurred_on: string | null; source_updated_at: string | null; raw_object_hash: string | null;
  payload_json: string; extension_json: string;
};

/**
 * Re-run normalization over already-captured nutrition entities without
 * contacting any provider. Idempotent upserts let a fixed normalizer backfill
 * previously mis-parsed nutrition_days/nutrition_items from stored payloads.
 */
export async function reimportNutrition(paths: CatencePaths): Promise<Record<string, unknown>> {
  if (!existsSync(paths.database)) throw new Error('No Catence database exists yet. Complete a sync before re-importing nutrition.');
  const database = await CatenceDatabase.open(paths);
  try {
    const rows = await database.rows<ReimportRow>(
      `SELECT provider, entity_type, remote_id, parent_remote_id, occurred_on, source_updated_at, raw_object_hash,
              cast(payload_json AS VARCHAR) AS payload_json, cast(extension_json AS VARCHAR) AS extension_json
       FROM source_entities
       WHERE entity_type IN ('nutrition_log', 'nutrition_day')
       ORDER BY provider, occurred_on, remote_id`,
    );
    for (const row of rows) {
      await importSourceEntity(database, {
        kind: 'source_entity', schemaVersion: 1, provider: row.provider as Provider, entityType: row.entity_type,
        remoteId: row.remote_id, parentRemoteId: row.parent_remote_id, occurredOn: row.occurred_on, sourceUpdatedAt: row.source_updated_at,
        rawObjectHash: row.raw_object_hash, payload: parseJsonObject(row.payload_json), extension: parseJsonObject(row.extension_json),
      });
    }
    const days = (await database.rows<{ count: number | bigint }>('SELECT count(*) AS count FROM nutrition_days'))[0]?.count ?? 0;
    const items = (await database.rows<{ count: number | bigint }>('SELECT count(*) AS count FROM nutrition_items'))[0]?.count ?? 0;
    return { reimportedEntities: rows.length, nutritionDays: days, nutritionItems: items };
  } finally {
    await database.close();
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}
