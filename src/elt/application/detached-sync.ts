import { spawn, type SpawnOptions } from 'node:child_process';
import { open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatencePaths } from '../../contracts/runtime.js';
import { syncProgress } from './management.js';

export const DETACHED_SYNC_PROVIDERS = ['intervals', 'garmin', 'strava', 'all'] as const;
export type DetachedSyncProvider = (typeof DETACHED_SYNC_PROVIDERS)[number];

export type DetachedSyncRequest = {
  paths: CatencePaths;
  athleteId: string;
  provider?: DetachedSyncProvider;
  from?: string;
  refresh?: boolean;
};

export type DetachedSyncHandle = {
  started: true;
  athleteId: string;
  provider: DetachedSyncProvider;
  logFile: string;
};

/** Raised when another sync run is already active for this store. */
export class DetachedSyncBusyError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`A Catence sync run is already active (${runId}). Watch it with the progress tools instead of starting another.`);
    this.name = 'DetachedSyncBusyError';
    this.runId = runId;
  }
}

/**
 * Resolve the packaged `catence-data` CLI entry next to this module. In a
 * built install both live under dist/; source checkouts run through tsx and
 * tests inject their own spawner.
 */
function cliScriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../interfaces/cli/main.js');
}

function assertValidRequest(request: DetachedSyncRequest): void {
  if (!request.athleteId || !/^[a-z][a-z0-9-]{0,62}$/.test(request.athleteId)) {
    throw new Error('athleteId is required and must be a lowercase athlete identifier.');
  }
  if (request.provider !== undefined && !DETACHED_SYNC_PROVIDERS.includes(request.provider)) {
    throw new Error('provider must be intervals, garmin, strava, or all.');
  }
  if (request.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(request.from)) {
    throw new Error('from must use YYYY-MM-DD.');
  }
}

/** Minimal structural spawner so tests can inject a fake child process. */
export type DetachedSyncSpawner = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

/**
 * Spawn one detached `catence-data sync` process for an athlete store and
 * return immediately.
 *
 * The child outlives this process (SSH deaths, Console restarts), logs to a
 * file under the catalog home, and is guarded by the same live-progress
 * heartbeat check the progress tools use. The guard and the spawn are not
 * atomic; the single-writer DuckDB lock remains the authoritative guard, so a
 * racing second child fails cleanly in its own log file.
 */
export async function startDetachedSync(
  request: DetachedSyncRequest,
  dependencies: { now?: () => Date; spawnProcess?: DetachedSyncSpawner } = {},
): Promise<DetachedSyncHandle> {
  assertValidRequest(request);
  const provider = request.provider ?? 'all';

  const snapshot = await syncProgress(request.paths);
  const activeRun = snapshot.running[0];
  if (activeRun) throw new DetachedSyncBusyError(activeRun.runId);

  const stamp = (dependencies.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(request.paths.root, 'logs', `sync-${request.athleteId}-${stamp}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, `[${new Date().toISOString()}] catence-data --athlete ${request.athleteId} sync --provider ${provider}${request.from ? ` --from ${request.from}` : ''}${request.refresh ? ' --refresh' : ''}\n`, 'utf8');

  const arguments_ = [cliScriptPath(), '--home', request.paths.root, '--athlete', request.athleteId, 'sync', '--provider', provider];
  if (request.from) arguments_.push('--from', request.from);
  if (request.refresh) arguments_.push('--refresh');

  // The file handle stays open only for the spawn; the detached child holds
  // its own duplicate of the descriptor afterwards.
  const logHandle = await open(logFile, 'a');
  try {
    const spawnProcess = dependencies.spawnProcess ?? spawn;
    const child = spawnProcess(process.execPath, arguments_, {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: process.env,
    });
    child.unref();
  } finally {
    await logHandle.close();
  }

  return { started: true, athleteId: request.athleteId, provider, logFile };
}
