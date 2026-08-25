import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatencePaths } from '../../contracts/runtime.js';
import { STALE_RUN_TIMEOUT_MS } from '../../contracts/progress.js';
import { syncProgress } from './management.js';

export const DETACHED_SYNC_PROVIDERS = ['intervals', 'garmin', 'strava', 'all'] as const;
export type DetachedSyncProvider = (typeof DETACHED_SYNC_PROVIDERS)[number];

export type DetachedSyncRequest = {
  paths: CatencePaths;
  athleteId: string;
  provider?: DetachedSyncProvider;
  from?: string;
  refresh?: boolean;
  /**
   * The `--home` value the detached `catence-data` child must receive.
   *
   * Catalog deployments pass the catalog root here: `paths` points at the
   * resolved athlete store (for locks/logs), but the child resolves
   * `--athlete` within a catalog, so pointing `--home` at the store itself
   * makes it fail with the legacy-store guard. Standalone stores omit this
   * and default to `paths.root`.
   */
  cliHome?: string;
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
 * Resolve how to launch the `catence-data` CLI next to this module.
 *
 * Built installs: both modules live under dist/, so the child is plain
 * `node …/dist/interfaces/cli/main.js`. Source checkouts run through tsx,
 * where the same relative path points at a nonexistent `.js` file — there the
 * TypeScript entry is launched through the checkout's local tsx binary
 * instead. Tests inject their own spawner and never reach this resolution.
 */
function cliInvocation(): { command: string; entry: string } {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const builtEntry = path.resolve(moduleDirectory, '../../interfaces/cli/main.js');
  if (existsSync(builtEntry)) return { command: process.execPath, entry: builtEntry };
  const sourceEntry = path.resolve(moduleDirectory, '../../interfaces/cli/main.ts');
  const tsxBinary = path.resolve(moduleDirectory, '../../../node_modules/.bin/tsx');
  if (!existsSync(sourceEntry) || !existsSync(tsxBinary)) {
    throw new Error(
      `Could not locate the catence-data CLI entry (tried ${builtEntry} and ${sourceEntry}). Install the package or run from a checkout with node_modules present.`,
    );
  }
  return { command: tsxBinary, entry: sourceEntry };
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
  // Belt-and-braces: syncProgress already age-filters stale runs, so this
  // predicate only re-asserts the sidecar contract at the decision point —
  // a heartbeat older than the stale timeout must never block a new run.
  const activeRun = snapshot.running.find((state) => {
    const ageMs = Date.now() - Date.parse(state.heartbeatAt);
    return Number.isFinite(ageMs) && ageMs <= STALE_RUN_TIMEOUT_MS;
  });
  if (activeRun) throw new DetachedSyncBusyError(activeRun.runId);

  const stamp = (dependencies.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(request.paths.root, 'logs', `sync-${request.athleteId}-${stamp}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, `[${new Date().toISOString()}] catence-data --athlete ${request.athleteId} sync --provider ${provider}${request.from ? ` --from ${request.from}` : ''}${request.refresh ? ' --refresh' : ''}\n`, 'utf8');

  const arguments_ = [cliInvocation().entry, '--home', request.cliHome ?? request.paths.root, '--athlete', request.athleteId, 'sync', '--provider', provider];
  if (request.from) arguments_.push('--from', request.from);
  if (request.refresh) arguments_.push('--refresh');

  // The file handle stays open only for the spawn; the detached child holds
  // its own duplicate of the descriptor afterwards.
  const logHandle = await open(logFile, 'a');
  try {
    const spawnProcess = dependencies.spawnProcess ?? spawn;
    const child = spawnProcess(cliInvocation().command, arguments_, {
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
