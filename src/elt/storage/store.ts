import { DuckDBInstance } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../../contracts/runtime.js';
import { STALE_RUN_TIMEOUT_MS } from '../../contracts/progress.js';
import { DetachedSyncBusyError, assertValidRequest, type DetachedSyncHandle, type DetachedSyncProvider, type DetachedSyncRequest } from '../application/detached-sync.js';
import { syncData, syncProgress } from '../application/management.js';
import { CatenceDatabase } from './database.js';

const IDLE_CLOSE_MS = 1_000;

/**
 * A process-wide DuckDB read-write instance. Every operation gets its own
 * connection, so a sync can write while another agent turn reads or hydrates
 * from a sibling connection. The registry only keeps the instance open while
 * someone is using it; after a short idle window the file lock is released so
 * ordinary CLI commands keep working.
 */
export class CatenceStore {
  private closing = false;
  private hydrationTail: Promise<unknown> = Promise.resolve();
  private readonly instance: DuckDBInstance;

  private constructor(instance: DuckDBInstance) {
    this.instance = instance;
  }

  static async open(paths: CatencePaths): Promise<CatenceStore> {
    const { instance, database } = await CatenceDatabase.openInstance(paths);
    await database.close();
    return new CatenceStore(instance);
  }

  /** Open a store connection. The caller closes it when the operation ends. */
  async database(): Promise<CatenceDatabase> {
    if (this.closing) throw new Error('The Catence data store is closing.');
    return CatenceDatabase.fromInstance(this.instance);
  }

  /**
   * Hydration is synchronous from the agent's point of view, but stacked agent
   * requests must not write the same segment/state rows concurrently. This
   * FIFO only serializes hydration jobs; sync imports keep their own connection
   * and are never put behind this queue.
   */
  withHydration<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The Catence data store is closing.'));
    const result = this.hydrationTail.then(work, work);
    this.hydrationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.hydrationTail.catch(() => undefined);
    this.instance.closeSync();
  }
}

type StoreEntry = {
  paths: CatencePaths;
  refs: number;
  ready: Promise<CatenceStore>;
  closing: boolean;
  idleTimer: NodeJS.Timeout | null;
  closePromise: Promise<void> | null;
};

/**
 * Refcounted owner registry. The server holds a reference for the lifetime of
 * a sync or hydration request and releases it afterwards; no connection is
 * kept open while the store is idle.
 */
export class CatenceStoreRegistry {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly activeSyncs = new Map<string, string>();

  async withStore<T>(paths: CatencePaths, work: (store: CatenceStore) => Promise<T>): Promise<T> {
    const entry = await this.acquire(paths);
    try {
      return await work(await entry.ready);
    } finally {
      this.release(entry);
    }
  }

  /** Open (and migrate) every configured athlete store once, then release it. */
  async initialize(pathsList: readonly CatencePaths[]): Promise<void> {
    for (const paths of pathsList) {
      await this.withStore(paths, async () => undefined);
    }
  }

  /**
   * Start an in-process sync. The returned handle is immediate; the store
   * reference keeps the owner alive until the run finishes, and the idle
   * close then releases the DuckDB file lock.
   */
  async startSync(request: DetachedSyncRequest): Promise<DetachedSyncHandle> {
    assertValidRequest(request);
    const provider: DetachedSyncProvider = request.provider ?? 'all';
    const key = request.paths.database;
    if (this.activeSyncs.has(key)) throw new DetachedSyncBusyError(this.activeSyncs.get(key) ?? 'unknown');

    const snapshot = await syncProgress(request.paths);
    if (this.activeSyncs.has(key)) throw new DetachedSyncBusyError(this.activeSyncs.get(key) ?? 'unknown');
    const active = snapshot.running.find((state) => {
      const ageMs = Date.now() - Date.parse(state.heartbeatAt);
      return Number.isFinite(ageMs) && ageMs <= STALE_RUN_TIMEOUT_MS;
    });
    if (active) throw new DetachedSyncBusyError(active.runId);

    const syncId = randomUUID();
    this.activeSyncs.set(key, syncId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(request.paths.root, 'logs', `sync-${request.athleteId}-${stamp}.log`);
    const subcommand = request.backfill ? 'backfill' : 'sync';
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(logFile, `[${new Date().toISOString()}] catence-data --athlete ${request.athleteId} ${subcommand} --provider ${provider}${request.from ? ` --from ${request.from}` : ''}${request.refresh ? ' --refresh' : ''} (in-process owner ${syncId})\n`, 'utf8');

    void (async () => {
      try {
        await this.withStore(request.paths, async (store) => {
          const result = await syncData(
            request.paths,
            provider,
            request.from,
            !request.backfill,
            request.refresh ?? false,
            request.backfill ?? false,
            { store },
          );
          await appendFile(logFile, `${JSON.stringify(result)}\n`, 'utf8');
        });
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        await appendFile(logFile, `${message}\n`, 'utf8').catch(() => undefined);
      } finally {
        this.activeSyncs.delete(key);
      }
    })();

    return { started: true, athleteId: request.athleteId, provider, logFile };
  }

  /** Number of process-wide instances currently held (mostly for diagnostics/tests). */
  get openStoreCount(): number {
    return this.entries.size;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (entry) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      await entry.ready.then((store) => store.close()).catch(() => undefined);
    }));
  }

  private async acquire(paths: CatencePaths): Promise<StoreEntry> {
    const key = paths.database;
    while (true) {
      const existing = this.entries.get(key);
      if (existing?.closing) {
        await existing.closePromise?.catch(() => undefined);
        continue;
      }
      if (existing) {
        existing.refs += 1;
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer);
          existing.idleTimer = null;
        }
        return existing;
      }
      const entry: StoreEntry = {
        paths,
        refs: 1,
        ready: CatenceStore.open(paths),
        closing: false,
        idleTimer: null,
        closePromise: null,
      };
      this.entries.set(key, entry);
      entry.ready.catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
      return entry;
    }
  }

  private release(entry: StoreEntry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.closing) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void this.closeEntry(entry);
    }, IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
  }

  private async closeEntry(entry: StoreEntry): Promise<void> {
    if (entry.refs > 0 || entry.closing) return;
    const key = entry.paths.database;
    if (this.entries.get(key) !== entry) return;
    entry.closing = true;
    entry.closePromise = (async () => {
      try {
        const store = await entry.ready;
        await store.close();
      } catch {
        // A store that never opened has no lock to release.
      } finally {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    })();
    await entry.closePromise;
  }
}
