import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_SYNC_INTERVAL_MINUTES,
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  parseAutoSyncInterval,
  readAutoSyncSchedule,
  startAutoSyncScheduler,
  updateAutoSyncSchedule,
} from '../src/elt/application/autosync.js';
import { athleteStorePaths, initializeCatalog, resolveCatalogPaths, type DetachedSyncHandle } from '../src/runtime/index.js';
import { DetachedSyncBusyError } from '../src/elt/application/detached-sync.js';
import { autoSyncFilePath } from '../src/elt/application/autosync.js';

async function temporaryCatalog() {
  const home = await mkdtemp(path.join(tmpdir(), 'catence-autosync-'));
  const catalogPaths = resolveCatalogPaths(home);
  await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
  const paths = athleteStorePaths(catalogPaths, 'alex');
  // initializeCatalog registers the athlete but does not materialize the
  // store directory; a schedule file can be its first artifact.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(paths.root, { recursive: true });
  return { catalogPaths, paths };
}

describe('parseAutoSyncInterval', () => {
  it('accepts labels and bare minutes', () => {
    expect(parseAutoSyncInterval('15m')).toBe(15);
    expect(parseAutoSyncInterval('2h')).toBe(120);
    expect(parseAutoSyncInterval('24h')).toBe(1440);
    expect(parseAutoSyncInterval('120')).toBe(120);
  });

  it('rejects unsupported cadences', () => {
    expect(() => parseAutoSyncInterval('45m')).toThrow('interval must be one of');
    expect(() => parseAutoSyncInterval('')).toThrow('interval must be one of');
  });
});

describe('readAutoSyncSchedule', () => {
  it('reports the default schedule (on, every 2 hours) without writing a file', async () => {
    const { paths } = await temporaryCatalog();
    const schedule = await readAutoSyncSchedule(paths, 'alex');
    expect(schedule).toMatchObject({ athleteId: 'alex', enabled: true, intervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES });
    expect(schedule.nextRunAt).toBeNull();
    expect(schedule.intervalOptions.map((option) => option.minutes)).toEqual([...AUTO_SYNC_INTERVAL_MINUTES]);
  });

  it('fails loud on a malformed autosync.json', async () => {
    const { paths } = await temporaryCatalog();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(autoSyncFilePath(paths), '{"enabled": "yes"}', 'utf8');
    await expect(readAutoSyncSchedule(paths, 'alex')).rejects.toThrow('not a valid auto-sync schedule');
  });
});

describe('updateAutoSyncSchedule', () => {
  it('persists explicit changes and keeps trigger bookkeeping', async () => {
    const { paths } = await temporaryCatalog();
    const disabled = await updateAutoSyncSchedule(paths, 'alex', { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    const hourly = await updateAutoSyncSchedule(paths, 'alex', { enabled: true, intervalMinutes: 60 });
    expect(hourly).toMatchObject({ enabled: true, intervalMinutes: 60, nextRunAt: null });
    // Unmodified fields survive an update round-trip.
    const reread = await readAutoSyncSchedule(paths, 'alex');
    expect(reread).toMatchObject({ enabled: true, intervalMinutes: 60 });
  });

  it('computes the next run from the last trigger plus the interval', async () => {
    const { paths } = await temporaryCatalog();
    const { writeFile } = await import('node:fs/promises');
    const lastTriggeredAt = '2026-10-16T08:00:00.000Z';
    await writeFile(autoSyncFilePath(paths), JSON.stringify({ enabled: true, intervalMinutes: 120, lastTriggeredAt, lastLogFile: null }), 'utf8');
    const schedule = await readAutoSyncSchedule(paths, 'alex');
    expect(schedule.nextRunAt).toBe('2026-10-16T10:00:00.000Z');
  });
});

describe('startAutoSyncScheduler', () => {
  it('triggers immediately for a default-on athlete without history and records the run', async () => {
    const { catalogPaths, paths } = await temporaryCatalog();
    const requests: Array<{ athleteId: string; cliHome: string | undefined }> = [];
    const scheduler = startAutoSyncScheduler({
      catalogPaths,
      now: () => new Date('2026-10-16T08:00:00.000Z'),
      startSync: async (request) => {
        requests.push({ athleteId: request.athleteId, cliHome: request.cliHome });
        return { started: true, athleteId: request.athleteId, provider: 'all', logFile: 'sync.log' } satisfies DetachedSyncHandle;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(requests).toEqual([{ athleteId: 'alex', cliHome: catalogPaths.root }]);
      const schedule = await readAutoSyncSchedule(paths, 'alex');
      expect(schedule.lastTriggeredAt).toBe('2026-10-16T08:00:00.000Z');
      expect(schedule.lastLogFile).toBe('sync.log');
      expect(schedule.nextRunAt).toBe('2026-10-16T10:00:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('skips a busy athlete and retries on a later tick', async () => {
    const { catalogPaths } = await temporaryCatalog();
    const attempts: string[] = [];
    let busy = true;
    const scheduler = startAutoSyncScheduler({
      catalogPaths,
      tickMs: 10,
      now: () => new Date('2026-10-16T08:00:00.000Z'),
      startSync: async (request) => {
        attempts.push(request.athleteId);
        if (busy) throw new DetachedSyncBusyError('active-run');
        return { started: true, athleteId: request.athleteId, provider: 'all', logFile: 'sync.log' } satisfies DetachedSyncHandle;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      const schedule = await readAutoSyncSchedule(athleteStorePaths(catalogPaths, 'alex'), 'alex');
      // The busy attempt must not consume the cadence.
      expect(schedule.lastTriggeredAt).toBeNull();
      busy = false;
    } finally {
      scheduler.stop();
    }
  });

  it('never fires for a disabled schedule', async () => {
    const { catalogPaths, paths } = await temporaryCatalog();
    await updateAutoSyncSchedule(paths, 'alex', { enabled: false });
    const requests: string[] = [];
    const scheduler = startAutoSyncScheduler({
      catalogPaths,
      now: () => new Date('2026-10-16T08:00:00.000Z'),
      startSync: async (request) => {
        requests.push(request.athleteId);
        return { started: true, athleteId: request.athleteId, provider: 'all', logFile: 'sync.log' } satisfies DetachedSyncHandle;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(requests).toEqual([]);
    } finally {
      scheduler.stop();
    }
  });

  it('writes a schedule file a human can read', async () => {
    const { paths } = await temporaryCatalog();
    await updateAutoSyncSchedule(paths, 'alex', { intervalMinutes: 720 });
    const content = await readFile(autoSyncFilePath(paths), 'utf8');
    expect(JSON.parse(content)).toMatchObject({ enabled: true, intervalMinutes: 720 });
  });
});
