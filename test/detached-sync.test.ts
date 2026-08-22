import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { resolvePaths } from '../src/core/runtime/configuration.js';
import { DetachedSyncBusyError, startDetachedSync } from '../src/elt/application/detached-sync.js';
import { PROGRESS_SIDECAR_SUFFIX } from '../src/elt/storage/progress-sidecar.js';

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'catence-detached-sync-'));
  return resolvePaths(root);
}

async function stageActiveRun(paths: ReturnType<typeof resolvePaths>, runId = 'active-run'): Promise<void> {
  await mkdir(path.join(paths.staging, 'garmin'), { recursive: true });
  const sidecar = path.join(paths.staging, 'garmin', `${runId}${PROGRESS_SIDECAR_SUFFIX}`);
  await writeFile(
    sidecar,
    JSON.stringify({
      runId,
      provider: 'garmin',
      stage: 'activities',
      currentStep: 'day',
      completedUnits: 3,
      totalUnits: 10,
      percentComplete: 30,
      elapsedSeconds: 12,
      estimatedRemainingSeconds: 30,
      heartbeatAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

type CapturedSpawn = { command: string; arguments_: readonly string[]; options: SpawnOptions };

function fakeSpawner(): { spawn: (command: string, args: readonly string[], options: SpawnOptions) => { unref(): void }; captures: CapturedSpawn[] } {
  const captures: CapturedSpawn[] = [];
  const spawn = (command: string, arguments_: readonly string[], options: SpawnOptions) => {
    captures.push({ command, arguments_, options });
    return { unref() {} };
  };
  return { spawn, captures };
}

describe('startDetachedSync', () => {
  it('spawns a detached catence-data sync with a log file under the catalog home', async () => {
    const paths = await temporaryStore();
    const { spawn, captures } = fakeSpawner();

    const handle = await startDetachedSync(
      { paths, athleteId: 'alex', provider: 'garmin', from: '2026-07-01', refresh: true },
      { now: () => new Date('2026-08-21T10:00:00.000Z'), spawnProcess: spawn },
    );

    expect(handle).toMatchObject({ started: true, athleteId: 'alex', provider: 'garmin' });
    expect(handle.logFile).toContain(path.join('logs', 'sync-alex-'));
    expect(captures).toHaveLength(1);
    const capture = captures[0]!;
    expect(capture.command).toBe(process.execPath);
    const scriptIndex = capture.arguments_.indexOf('sync');
    expect(scriptIndex).toBeGreaterThan(0);
    expect(capture.arguments_).toEqual(expect.arrayContaining(['--home', paths.root, '--athlete', 'alex', 'sync', '--provider', 'garmin', '--from', '2026-07-01', '--refresh']));
    expect(capture.options).toMatchObject({ detached: true });
    // The child's stdout/stderr are the log file descriptors.
    expect((capture.options.stdio as Array<unknown>)[1]).toEqual(expect.any(Number));

    const logHeader = await readFile(handle.logFile, 'utf8');
    expect(logHeader).toContain('--provider garmin');
  });

  it('refuses to start while another sync run is active', async () => {
    const paths = await temporaryStore();
    await stageActiveRun(paths);
    const { spawn, captures } = fakeSpawner();

    await expect(startDetachedSync({ paths, athleteId: 'alex' }, { spawnProcess: spawn })).rejects.toMatchObject({
      name: 'DetachedSyncBusyError',
      runId: 'active-run',
    });
    expect(captures).toHaveLength(0);
  });

  it('validates provider and date inputs before touching the filesystem', async () => {
    const paths = await temporaryStore();
    const { spawn, captures } = fakeSpawner();
    await expect(startDetachedSync({ paths, athleteId: 'alex', provider: 'nope' as never }, { spawnProcess: spawn })).rejects.toThrow('provider must be intervals, garmin, strava, or all.');
    await expect(startDetachedSync({ paths, athleteId: 'alex', from: '01-07-2026' }, { spawnProcess: spawn })).rejects.toThrow('from must use YYYY-MM-DD.');
    await expect(startDetachedSync({ paths, athleteId: 'Not Valid' }, { spawnProcess: spawn })).rejects.toThrow('athleteId is required');
    expect(captures).toHaveLength(0);
  });

  it('exposes a stable busy error for HTTP and MCP surfaces', () => {
    const error = new DetachedSyncBusyError('run-123');
    expect(error.runId).toBe('run-123');
    expect(error.message).toContain('run-123');
  });
});
