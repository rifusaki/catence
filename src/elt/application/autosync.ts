import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { athleteStorePaths, loadCatalog, type CatalogPaths } from '../../core/runtime/catalog.js';
import type { CatencePaths } from '../../contracts/runtime.js';
import { createSyncLogger } from '../../core/logging.js';
import { DetachedSyncBusyError, startDetachedSync, type DetachedSyncHandle } from './detached-sync.js';

/** The sync cadences the scheduler accepts, in minutes. */
export const AUTO_SYNC_INTERVAL_MINUTES = [15, 30, 60, 120, 360, 720, 1440] as const;
export type AutoSyncIntervalMinutes = (typeof AUTO_SYNC_INTERVAL_MINUTES)[number];

/** Auto-sync is on by default at 2h: fresh data several times a day, far inside provider limits. */
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES: AutoSyncIntervalMinutes = 120;

const INTERVAL_CHOICE_LABELS: ReadonlyMap<AutoSyncIntervalMinutes, string> = new Map([
  [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [360, '6h'], [720, '12h'], [1440, '24h'],
]);

const autoSyncFileSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().refine((value): value is AutoSyncIntervalMinutes =>
    (AUTO_SYNC_INTERVAL_MINUTES as readonly number[]).includes(value),
    'intervalMinutes must be one of 15, 30, 60, 120, 360, 720, 1440.'),
  lastTriggeredAt: z.string().datetime().nullable().default(null),
  lastLogFile: z.string().nullable().default(null),
}).strict();

export type AutoSyncConfig = z.infer<typeof autoSyncFileSchema>;

export type AutoSyncSchedule = {
  athleteId: string;
  enabled: boolean;
  intervalMinutes: AutoSyncIntervalMinutes;
  intervalOptions: ReadonlyArray<{ minutes: AutoSyncIntervalMinutes; label: string }>;
  lastTriggeredAt: string | null;
  lastLogFile: string | null;
  nextRunAt: string | null;
};

export function autoSyncFilePath(paths: CatencePaths): string {
  return path.join(paths.root, 'autosync.json');
}

/**
 * Parse one of the interval labels the UI and CLI accept (`15m`, `2h`, `24h`)
 * or a bare minute count into a valid cadence. Anything else is rejected at
 * the boundary so stored state can never hold an unsupported interval.
 */
export function parseAutoSyncInterval(value: string): AutoSyncIntervalMinutes {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(m|h)$/.exec(trimmed);
  const minutes = match ? (match[2] === 'h' ? Number(match[1]) * 60 : Number(match[1])) : Number(trimmed);
  if (Number.isInteger(minutes) && (AUTO_SYNC_INTERVAL_MINUTES as readonly number[]).includes(minutes)) {
    return minutes as AutoSyncIntervalMinutes;
  }
  throw new Error(`interval must be one of: ${[...INTERVAL_CHOICE_LABELS.values()].join(', ')}.`);
}

function defaultConfig(): AutoSyncConfig {
  return { enabled: true, intervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES, lastTriggeredAt: null, lastLogFile: null };
}

function nextRunAt(config: AutoSyncConfig): string | null {
  if (!config.enabled || !config.lastTriggeredAt) return null;
  return new Date(Date.parse(config.lastTriggeredAt) + config.intervalMinutes * 60_000).toISOString();
}

function toSchedule(athleteId: string, config: AutoSyncConfig): AutoSyncSchedule {
  return {
    athleteId,
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    intervalOptions: AUTO_SYNC_INTERVAL_MINUTES.map((minutes) => ({ minutes, label: INTERVAL_CHOICE_LABELS.get(minutes) ?? `${minutes}m` })),
    lastTriggeredAt: config.lastTriggeredAt,
    lastLogFile: config.lastLogFile,
    nextRunAt: nextRunAt(config),
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

async function readEffectiveConfig(paths: CatencePaths): Promise<AutoSyncConfig> {
  let raw: string;
  try {
    raw = await readFile(autoSyncFilePath(paths), 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return defaultConfig();
  }
  const parsed = autoSyncFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`autosync.json is not a valid auto-sync schedule (${parsed.error.issues[0]?.message ?? 'unknown issue'}).`);
  }
  return parsed.data;
}

/**
 * Read the athlete's schedule. A missing file means "on by default": the
 * effective schedule is reported without writing anything, so a fresh store
 * stays pristine until the first explicit change (the scheduler does write
 * trigger bookkeeping once it actually fires).
 */
export async function readAutoSyncSchedule(paths: CatencePaths, athleteId: string): Promise<AutoSyncSchedule> {
  return toSchedule(athleteId, await readEffectiveConfig(paths));
}

async function writeAutoSyncConfig(paths: CatencePaths, config: AutoSyncConfig): Promise<void> {
  const file = autoSyncFilePath(paths);
  // A freshly added athlete has no store directory yet; the schedule file is
  // often its first artifact.
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/**
 * Apply an explicit schedule change (UI or CLI). Only the requested fields
 * change; trigger bookkeeping survives an interval switch or a pause.
 */
export async function updateAutoSyncSchedule(
  paths: CatencePaths,
  athleteId: string,
  change: { enabled?: boolean; intervalMinutes?: AutoSyncIntervalMinutes },
): Promise<AutoSyncSchedule> {
  const current = await readEffectiveConfig(paths);
  const updated: AutoSyncConfig = {
    ...current,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    ...(change.intervalMinutes === undefined ? {} : { intervalMinutes: change.intervalMinutes }),
  };
  await writeAutoSyncConfig(paths, updated);
  return toSchedule(athleteId, updated);
}

/** Record that the scheduler fired (or attempted to fire) for this athlete. */
async function recordTrigger(paths: CatencePaths, logFile: string | null, at: Date): Promise<void> {
  const config = await readEffectiveConfig(paths);
  await writeAutoSyncConfig(paths, { ...config, lastTriggeredAt: at.toISOString(), lastLogFile: logFile });
}

export type AutoSyncSchedulerOptions = {
  catalogPaths: CatalogPaths;
  /** Internal compatibility hook for tests. */
  startSync?: (request: Parameters<typeof startDetachedSync>[0]) => Promise<DetachedSyncHandle>;
  now?: () => Date;
  /** How often due schedules are checked; default every 30 seconds. */
  tickMs?: number;
};

export type AutoSyncScheduler = { stop(): void };

/**
 * The auto-sync scheduler: a periodic timer that triggers a detached sync for
 * every athlete whose schedule is due. It opens no database connection and
 * takes no locks — the detached child and the single-writer DuckDB lock stay
 * the only sync executors, so an already-running sync simply makes the tick a
 * no-op (DetachedSyncBusyError is skipped quietly and retried on a later
 * tick, once the active run has finished).
 */
export function startAutoSyncScheduler(options: AutoSyncSchedulerOptions): AutoSyncScheduler {
  const startSync = options.startSync ?? startDetachedSync;
  const now = options.now ?? (() => new Date());
  const tickMs = options.tickMs ?? 30_000;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return; // Never overlap ticks; the in-flight one wins.
    ticking = true;
    try {
      const catalog = await loadCatalog(options.catalogPaths);
      await Promise.allSettled(catalog.athletes.map(async (athlete) => {
        const paths = athleteStorePaths(options.catalogPaths, athlete.id);
        const log = createSyncLogger(paths);
        try {
          const config = await readEffectiveConfig(paths);
          if (!config.enabled) return;
          const dueAt = config.lastTriggeredAt ? Date.parse(config.lastTriggeredAt) + config.intervalMinutes * 60_000 : 0;
          if (now().getTime() < dueAt) return;
          const handle = await startSync({ paths, athleteId: athlete.id, provider: 'all', cliHome: options.catalogPaths.root });
          await recordTrigger(paths, handle.logFile, now());
          log.info('Auto-sync triggered', { athleteId: athlete.id, intervalMinutes: config.intervalMinutes, logFile: handle.logFile });
        } catch (error) {
          if (error instanceof DetachedSyncBusyError) return; // A run is active; retry on a later tick.
          // Any other failure is recorded as a trigger attempt so a broken
          // store cannot be hammered every tick; the next cadence retries.
          await recordTrigger(paths, null, now()).catch(() => undefined);
          log.error('Auto-sync trigger failed', { athleteId: athlete.id, error: error instanceof Error ? error.message : String(error) });
        }
      }));
    } catch (error) {
      process.stderr.write(`[catence] Auto-sync tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, tickMs);
  timer.unref?.();
  // The first tick is immediate: a restart should heal stale data within a
  // minute instead of waiting a full interval.
  void tick();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
