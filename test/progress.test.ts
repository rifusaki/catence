import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncProgressState } from '../src/contracts/progress.js';
import type { CatencePaths } from '../src/contracts/runtime.js';
import type { SyncLogger } from '../src/core/logging.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import {
  mergeProgress,
  ProgressPump,
  progressSidecarPath,
  readProgressSidecars,
  readRunningProgress,
  removeProgressSidecar,
  writeProgressSidecar,
} from '../src/elt/storage/progress-sidecar.js';
import { temporaryDatabase } from './helpers.js';

const noopLogger: SyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function readSidecar(paths: CatencePaths, runId: string, predicate?: (state: SyncProgressState) => boolean): Promise<SyncProgressState> {
  const target = progressSidecarPath(paths, runId);
  return await vi.waitFor(async () => {
    if (!existsSync(target)) throw new Error(`sidecar ${runId} not written yet`);
    const parsed = JSON.parse(await readFile(target, 'utf8')) as SyncProgressState;
    if (predicate && !predicate(parsed)) throw new Error(`sidecar ${runId} content not ready`);
    return parsed;
  });
}

function sampleState(runId: string, overrides: Partial<SyncProgressState> = {}): SyncProgressState {
  return {
    runId,
    provider: 'garmin',
    stage: 'daily',
    currentStep: null,
    completedUnits: 1,
    totalUnits: 10,
    percentComplete: 10,
    elapsedSeconds: 30,
    estimatedRemainingSeconds: 270,
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('sync run progress tracking', () => {
  it('migration 14 creates sync_run_progress', async () => {
    const { database } = await temporaryDatabase();
    try {
      await database.run(
        'INSERT INTO sync_run_progress (run_id, provider, stage, completed_units, percent, elapsed_seconds, heartbeat_at) VALUES ($runId, $provider, $stage, 0, 0, 0, now())',
        { runId: 'mig-14-check', provider: 'garmin', stage: 'starting' },
      );
      const rows = await database.rows<{ count: bigint }>(
        "SELECT count(*) AS count FROM sync_run_progress WHERE run_id = 'mig-14-check'",
      );
      expect(rows[0].count).toBe(1n);
    } finally {
      await database.close();
    }
  });

  it('heartbeatRun upserts progress and syncProgress reports the running run', async () => {
    const { database } = await temporaryDatabase();
    try {
      const runId = await database.beginRun('garmin', '2025-07-30');
      const heartbeat: SyncProgressState = {
        runId,
        provider: 'garmin',
        stage: 'daily',
        currentStep: '2025-08-01',
        completedUnits: 3,
        totalUnits: 10,
        percentComplete: 30,
        elapsedSeconds: 90,
        estimatedRemainingSeconds: 210,
        heartbeatAt: new Date().toISOString(),
      };
      await database.heartbeatRun(runId, heartbeat);

      const snapshot = await database.syncProgress();
      expect(snapshot.running).toHaveLength(1);
      expect(snapshot.running[0]).toMatchObject({
        runId,
        provider: 'garmin',
        stage: 'daily',
        currentStep: '2025-08-01',
        completedUnits: 3,
        totalUnits: 10,
        percentComplete: 30,
      });
      expect(snapshot.recent[0]).toMatchObject({ runId, stage: 'daily' });

      await database.heartbeatRun(runId, { ...heartbeat, completedUnits: 5, percentComplete: 50 });
      const updated = await database.syncProgress();
      expect(updated.running[0].completedUnits).toBe(5);
      expect(updated.running[0].percentComplete).toBe(50);
      expect(await database.rows<{ count: bigint }>('SELECT count(*) AS count FROM sync_run_progress')).toEqual([
        { count: 1n },
      ]);
    } finally {
      await database.close();
    }
  });

  it('markRunInterrupted marks the run and progress as interrupted', async () => {
    const { database } = await temporaryDatabase();
    try {
      const runId = await database.beginRun('garmin', '2025-07-30');
      await database.heartbeatRun(runId, {
        runId,
        provider: 'garmin',
        stage: 'activities',
        currentStep: '1234567890',
        completedUnits: 1,
        totalUnits: 4,
        percentComplete: 25,
        elapsedSeconds: 12,
        estimatedRemainingSeconds: 36,
        heartbeatAt: new Date().toISOString(),
      });
      await database.markRunInterrupted(runId);

      const rows = await database.rows<{ status: string }>('SELECT status FROM sync_runs WHERE run_id = $runId', {
        runId,
      });
      expect(rows[0].status).toBe('interrupted');
      const snapshot = await database.syncProgress();
      expect(snapshot.running).toHaveLength(0);
      expect(snapshot.recent[0]).toMatchObject({ runId, stage: 'interrupted' });
    } finally {
      await database.close();
    }
  });

  it('interruptStaleSyncRuns marks only runs older than the timeout as timed_out', async () => {
    const { database } = await temporaryDatabase();
    try {
      const staleRunId = await database.beginRun('garmin', '2025-07-30');
      await database.run('UPDATE sync_runs SET started_at = started_at - INTERVAL 1 DAY WHERE run_id = $runId', {
        runId: staleRunId,
      });
      const freshRunId = await database.beginRun('garmin', '2025-07-30');

      const result = await database.interruptStaleSyncRuns(1000);
      expect(result).toEqual({ runIds: [staleRunId] });

      const rows = await database.rows<{ run_id: string; status: string }>(
        'SELECT run_id, status FROM sync_runs',
      );
      const byRunId = Object.fromEntries(rows.map((row) => [row.run_id, row.status]));
      expect(byRunId).toEqual({ [freshRunId]: 'running', [staleRunId]: 'timed_out' });
      const snapshot = await database.syncProgress();
      expect(snapshot.running).toHaveLength(1);
      expect(snapshot.running[0].runId).toBe(freshRunId);
    } finally {
      await database.close();
    }
  });
});

describe('sync run progress sidecars', () => {
  it('writeProgressSidecar writes a readable file and removeProgressSidecar deletes it', async () => {
    const { paths } = await temporaryDatabase();
    const runId = 'sidecar-write';
    await writeProgressSidecar(paths, runId, sampleState(runId));

    const target = progressSidecarPath(paths, runId);
    expect(existsSync(target)).toBe(true);
    const state = JSON.parse(await readFile(target, 'utf8')) as SyncProgressState;
    expect(state).toMatchObject({ runId, stage: 'daily', completedUnits: 1, totalUnits: 10 });

    await removeProgressSidecar(paths, runId);
    expect(existsSync(target)).toBe(false);
  });

  it('readRunningProgress filters terminal stages and stale heartbeats', async () => {
    const { paths } = await temporaryDatabase();
    const liveRunId = 'sidecar-live';
    const terminalRunId = 'sidecar-terminal';
    const staleRunId = 'sidecar-stale';
    await writeProgressSidecar(paths, liveRunId, sampleState(liveRunId));
    await writeProgressSidecar(paths, terminalRunId, sampleState(terminalRunId, { stage: 'interrupted' }));
    await writeProgressSidecar(paths, staleRunId, sampleState(staleRunId, { heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));

    const running = await readRunningProgress(paths);
    expect(running.map((state) => state.runId)).toEqual([liveRunId]);

    // Terminal and stale sidecars are swept during the read, so a finished
    // run whose cleanup raced its final publish can never resurface as an
    // active sync on any later read.
    const survivors = await readProgressSidecars(paths);
    expect(survivors.map((state) => state.runId)).toEqual([liveRunId]);
  });

  it('mergeProgress lets sidecar state win for running runs and sorts recent by heartbeat', async () => {
    const runId = 'sidecar-merge';
    const dbRunning = [sampleState(runId, { completedUnits: 2, percentComplete: 20 })];
    const dbRecent = [
      sampleState('recent-a', { stage: 'completed' }),
      sampleState(runId, { completedUnits: 2, percentComplete: 20, heartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
    ];
    const sidecars = [sampleState(runId, { completedUnits: 8, percentComplete: 80, heartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() })];

    const merged = mergeProgress(dbRunning, dbRecent, sidecars);
    expect(merged.running[0]).toMatchObject({ runId, completedUnits: 8, percentComplete: 80 });
    expect(merged.recent[0].runId).toBe('recent-a');
    expect(merged.recent.map((state) => state.runId)).toEqual(['recent-a', runId]);
  });

  it('repository.progress() surfaces a sidecar-backed run without a database entry', async () => {
    const { paths, database } = await temporaryDatabase();
    await writeProgressSidecar(paths, 'sidecar-only', sampleState('sidecar-only', { stage: 'collections' }));
    await database.close();

    const repository = await openReadOnlyRepository(paths);
    try {
      const snapshot = await repository.progress();
      expect(snapshot.running).toHaveLength(1);
      expect(snapshot.running[0]).toMatchObject({ runId: 'sidecar-only', stage: 'collections' });
    } finally {
      await repository.close();
    }
  });
});

describe('ProgressPump', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publish persists a sidecar at progressSidecarPath', async () => {
    vi.useFakeTimers();
    const { paths, database } = await temporaryDatabase();
    try {
      const runId = 'pump-publish';
      await database.beginRun('garmin', '2025-07-30');
      const pump = new ProgressPump(runId, 'garmin', { database, paths, log: noopLogger });
      pump.publish(sampleState(runId));
      await vi.advanceTimersByTimeAsync(0);

      const state = await readSidecar(paths, runId);
      expect(state).toMatchObject({ runId, stage: 'daily', completedUnits: 1, totalUnits: 10 });
    } finally {
      await database.close();
    }
  });

  it('keepAlive refreshes heartbeatAt after 30s with no new worker output', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { paths, database } = await temporaryDatabase();
    try {
      const runId = 'pump-keepalive';
      await database.beginRun('garmin', '2025-07-30');
      const pump = new ProgressPump(runId, 'garmin', { database, paths, log: noopLogger });
      pump.start();
      pump.publish(sampleState(runId, { heartbeatAt: new Date(Date.now() - 60_000).toISOString() }));
      await vi.advanceTimersByTimeAsync(0);

      const before = await readSidecar(paths, runId);
      await vi.advanceTimersByTimeAsync(30_000);

      const after = await readSidecar(paths, runId, (state) => Date.parse(state.heartbeatAt) > Date.parse(before.heartbeatAt));
      expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
      pump.stop();
    } finally {
      await database.close();
    }
  });

  it('stop() clears the keepAlive interval', async () => {
    vi.useFakeTimers();
    const { paths, database } = await temporaryDatabase();
    try {
      const runId = 'pump-stop';
      await database.beginRun('garmin', '2025-07-30');
      const pump = new ProgressPump(runId, 'garmin', { database, paths, log: noopLogger });
      pump.start();
      pump.publish(sampleState(runId, { heartbeatAt: new Date(Date.now() - 60_000).toISOString() }));
      await vi.advanceTimersByTimeAsync(0);

      const before = await readSidecar(paths, runId);
      pump.stop();
      await vi.advanceTimersByTimeAsync(30_000);

      const after = await readSidecar(paths, runId);
      expect(after.heartbeatAt).toBe(before.heartbeatAt);
    } finally {
      await database.close();
    }
  });

  it('setStageImporting() persists an importing stage via keepAlive', async () => {
    vi.useFakeTimers();
    const { paths, database } = await temporaryDatabase();
    try {
      const runId = 'pump-importing';
      await database.beginRun('garmin', '2025-07-30');
      const pump = new ProgressPump(runId, 'garmin', { database, paths, log: noopLogger });
      pump.start();
      pump.publish(sampleState(runId));
      pump.setStageImporting();
      await vi.advanceTimersByTimeAsync(30_000);

      const state = await readSidecar(paths, runId);
      expect(state.stage).toBe('importing');
      pump.stop();
    } finally {
      await database.close();
    }
  });

  it('publishFinal forces a terminal write past the publish throttle', async () => {
    vi.useFakeTimers();
    const { paths, database } = await temporaryDatabase();
    try {
      const runId = 'pump-final';
      await database.beginRun('garmin', '2025-07-30');
      const pump = new ProgressPump(runId, 'garmin', { database, paths, log: noopLogger });
      pump.publish(sampleState(runId));
      pump.publishFinal(sampleState(runId, { stage: 'completed' }));
      await vi.advanceTimersByTimeAsync(0);

      const state = await readSidecar(paths, runId);
      expect(state).toMatchObject({ runId, stage: 'completed' });
    } finally {
      await database.close();
    }
  });
});
