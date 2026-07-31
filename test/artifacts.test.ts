import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { storeJsonArtifact } from '../src/elt/storage/artifacts.js';
import { temporaryDatabase } from './helpers.js';

describe('raw artifacts', () => {
  it('uses a content hash path and does not rewrite identical payloads', async () => {
    const { paths, database } = await temporaryDatabase();
    try {
      const first = await storeJsonArtifact(paths, 'intervals', 'activities', 'a1', { a: 1 });
      const second = await storeJsonArtifact(paths, 'intervals', 'activities', 'a1', { a: 1 });
      expect(second).toEqual(first);
      const contents = await readFile(path.join(paths.root, first.relativePath), 'utf8');
      expect(JSON.parse(contents)).toEqual({ a: 1 });
    } finally {
      await database.close();
    }
  });
});
