import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProgress, type SyncProgressSnapshot, type SyncProgressState } from '../../contracts/progress.js';
import type { CatencePaths } from '../../contracts/runtime.js';

export const PROGRESS_SIDECAR_SUFFIX = '.progress.json';
export const PROGRESS_SIDECAR_STALE_MS = 5 * 60 * 1000;

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
  const temporary = `${target}.tmp`;
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
  const running: SyncProgressState[] = [];
  for (const state of await readProgressSidecars(paths)) {
    if (TERMINAL_STAGES.has(state.stage)) continue;
    const ageMs = now - Date.parse(state.heartbeatAt);
    if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) continue;
    running.push(state);
  }
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
