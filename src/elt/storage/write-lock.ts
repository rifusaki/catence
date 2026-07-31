import { open, unlink } from 'node:fs/promises';
import type { CatencePaths } from '../../contracts/runtime.js';

export class DataWriteBusyError extends Error {
  constructor() {
    super('Another Catence sync or enrichment request currently owns the data directory. Retry after it completes.');
    this.name = 'DataWriteBusyError';
  }
}

/** Serializes short writer transactions across local CLI and stdio MCP processes. */
export async function withDataWriteLock<T>(paths: CatencePaths, work: () => Promise<T>): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(paths.lock, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DataWriteBusyError();
    throw error;
  }
  try {
    return await work();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(paths.lock).catch(() => undefined);
  }
}
