import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensurePaths, resolvePaths, type CatencePaths } from '../src/core/runtime/configuration.js';
import { CatenceDatabase } from '../src/elt/storage/database.js';

export async function temporaryDatabase(): Promise<{ paths: CatencePaths; database: CatenceDatabase }> {
  const root = await mkdtemp(path.join(tmpdir(), 'catence-test-'));
  const paths = resolvePaths(root);
  await ensurePaths(paths);
  return { paths, database: await CatenceDatabase.open(paths) };
}
