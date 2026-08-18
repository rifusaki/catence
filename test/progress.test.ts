import { describe, expect, it } from 'vitest';
import type { SyncProgressState } from '../src/contracts/progress.js';
import { temporaryDatabase } from './helpers.js';

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
