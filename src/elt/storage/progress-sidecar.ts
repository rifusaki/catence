import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeProgress,
  type SyncProgressSnapshot,
  type SyncProgressState,
  type SyncStage,
} from '../../contracts/progress.js';
import type { CatencePaths } from '../../contracts/runtime.js';
import type { SyncLogger } from '../../core/logging.js';
import type { CatenceDatabase } from './database.js';

export const PROGRESS_SIDECAR_SUFFIX = '.progress.json';
export const PROGRESS_SIDECAR_STALE_MS = 5 * 60 * 1000;
export const PROGRESS_KEEPALIVE_MS = 30 * 1000;
export const PROGRESS_PUBLISH_THROTTLE_MS = 2 * 1000;

const TERMINAL_STAGES = new Set(['completed', 'failed', 'interrupted', 'timed_out']);

export function progressSidecarPath(paths: CatencePaths, runId: string): string {
  return path.join(paths.staging, 'garmin', `${runId}${PROGRESS_SIDECAR_SUFFIX}`);
}

/**
 * Persist one progress heartbeat as a sidecar file next to the Garmin staging
 * manifest. Reading this file needs no DuckDB lock, so `progress` stays live
 * while a sync run holds the single-writer database lock.
 */
export async function writeProgressSidecar(paths: CatencePaths, runId: string, state: SyncProgressState): Promise<void> {
  const target = progressSidecarPath(paths, runId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, target);
}

export async function removeProgressSidecar(paths: CatencePaths, runId: string): Promise<void> {
  await rm(progressSidecarPath(paths, runId), { force: true });
}

/**
 * Scan every persisted sidecar heartbeat for an athlete store. Corrupt or
 * unreadable files are skipped so a torn write can never break progress reads.
 */
export async function readProgressSidecars(paths: CatencePaths): Promise<SyncProgressState[]> {
  const directory = path.join(paths.staging, 'garmin');
  if (!existsSync(directory)) return [];
  const files = (await readdir(directory)).filter((file) => file.endsWith(PROGRESS_SIDECAR_SUFFIX));
  const states: SyncProgressState[] = [];
  for (const file of files) {
    try {
      const state = normalizeProgress(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
      if (state) states.push(state);
    } catch {
      // Torn or partial sidecar write; it is not authoritative.
    }
  }
  return states;
}

/** Active runs from sidecars: non-terminal stage and a fresh heartbeat. */
export async function readRunningProgress(paths: CatencePaths, staleAfterMs = PROGRESS_SIDECAR_STALE_MS): Promise<SyncProgressState[]> {
  const now = Date.now();
  const directory = path.join(paths.staging, 'garmin');
  if (!existsSync(directory)) return [];
  const files = (await readdir(directory)).filter((file) => file.endsWith(PROGRESS_SIDECAR_SUFFIX));
  const running: SyncProgressState[] = [];
  const prunable: string[] = [];
  for (const file of files) {
    let state: SyncProgressState | null = null;
    try {
      state = normalizeProgress(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
    } catch {
      // Torn or partial sidecar write; it is not authoritative.
    }
    if (!state) continue;
    const ageMs = now - Date.parse(state.heartbeatAt);
    if (TERMINAL_STAGES.has(state.stage) || !Number.isFinite(ageMs) || ageMs > staleAfterMs) {
      // A terminal heartbeat that survived its own cleanup (a crash between
      // the final publish and the sidecar removal) must never read as an
      // active run again, so sweep it instead of leaving it behind forever.
      prunable.push(file);
      continue;
    }
    running.push(state);
  }
  await Promise.all(prunable.map((file) => rm(path.join(directory, file), { force: true }).catch(() => undefined)));
  return running;
}

/**
 * Merge database-backed progress with sidecar heartbeats. Sidecars win for a
 * given run (they are freshest); database rows fill runs that never emitted a
 * sidecar (for example Intervals runs). Recent history is deduplicated across
 * both sources and sorted by heartbeat recency.
 */
export function mergeProgress(dbRunning: SyncProgressState[], dbRecent: SyncProgressState[], sidecars: SyncProgressState[]): SyncProgressSnapshot {
  const running = new Map<string, SyncProgressState>();
  for (const state of sidecars) running.set(state.runId, state);
  for (const state of dbRunning) if (!running.has(state.runId)) running.set(state.runId, state);
  const recent = new Map<string, SyncProgressState>();
  for (const state of dbRecent) recent.set(state.runId, state);
  for (const state of sidecars) recent.set(state.runId, state);
  return {
    running: [...running.values()],
    recent: [...recent.values()]
      .sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))
      .slice(0, 10),
  };
}

function baselineState(runId: string, provider: string, stage: SyncStage): SyncProgressState {
  return {
    runId,
    provider,
    stage,
    currentStep: null,
    completedUnits: 0,
    totalUnits: null,
    percentComplete: 0,
    elapsedSeconds: 0,
    estimatedRemainingSeconds: null,
    heartbeatAt: new Date().toISOString(),
  };
}

export interface ProgressPumpOptions {
  database: CatenceDatabase;
  paths: CatencePaths;
  log: SyncLogger;
}

/**
 * Drives progress heartbeats for the whole lifetime of a sync run - including
 * phases that emit no worker output (the Intervals extractor and the Garmin
 * JSONL import). `publish` throttles writes to the database and sidecar; a
 * 30-second keep-alive interval refreshes the last known state so a run never
 * looks stale while it is still active, even during the lock-holding import.
 */
export class ProgressPump {
  private lastProgress: SyncProgressState | null = null;
  private lastHeartbeatAt = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stageOverride: SyncStage | null = null;

  constructor(
    private readonly runId: string,
    private readonly provider: string,
    private readonly options: ProgressPumpOptions,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.publish(
        this.lastProgress
          ? { ...this.lastProgress, heartbeatAt: new Date().toISOString() }
          : baselineState(this.runId, this.provider, this.stageOverride ?? 'starting'),
      );
    }, PROGRESS_KEEPALIVE_MS);
    this.interval.unref();
  }

  publish(state: SyncProgressState): void {
    const now = Date.now();
    if (this.lastHeartbeatAt !== 0 && now - this.lastHeartbeatAt < PROGRESS_PUBLISH_THROTTLE_MS) {
      this.lastProgress = state;
      return;
    }
    this.lastHeartbeatAt = now;
    this.lastProgress = state;
    const { database, paths, log } = this.options;
    void database.heartbeatRun(this.runId, state).catch((error: unknown) => {
      log.debug('Progress heartbeat failed', { runId: this.runId, error: error instanceof Error ? error.message : String(error) });
    });
    void writeProgressSidecar(paths, this.runId, state).catch((error: unknown) => {
      log.debug('Progress sidecar write failed', { runId: this.runId, error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Force subsequent keep-alive heartbeats to report the given stage. */
  setStage(stage: SyncStage): void {
    this.stageOverride = stage;
    if (this.lastProgress) {
      this.lastProgress = { ...this.lastProgress, stage };
      this.publish(this.lastProgress);
    }
  }

  /** Transition the run to the JSONL import stage; keep-alives persist it. */
  setStageImporting(): void {
    this.setStage('importing');
  }

  /** Write a terminal heartbeat immediately, bypassing the publish throttle. */
  async publishFinal(state: SyncProgressState): Promise<void> {
    this.lastHeartbeatAt = Date.now();
    this.lastProgress = state;
    const { database, paths, log } = this.options;
    // Both terminal writes complete before the caller removes the sidecar, so
    // a finished run can never resurrect its own progress file after cleanup.
    await database.heartbeatRun(this.runId, state).catch((error: unknown) => {
      log.debug('Progress heartbeat failed', { runId: this.runId, error: error instanceof Error ? error.message : String(error) });
    });
    await writeProgressSidecar(paths, this.runId, state).catch((error: unknown) => {
      log.debug('Progress sidecar write failed', { runId: this.runId, error: error instanceof Error ? error.message : String(error) });
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
