import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeCatalog, resolveCatalogPaths } from '../src/runtime/index.js';

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'catence-catalog-'));
}

describe('initializeCatalog', () => {
  it('refuses a home with unrelated contents', async () => {
    const home = await temporaryHome();
    await writeFile(path.join(home, 'notes.txt'), 'keep me');
    await expect(initializeCatalog(resolveCatalogPaths(home), { id: 'alex', label: 'Alex' })).rejects.toThrow(
      'Refusing to initialize'
    );
  });

  it('refuses a legacy 0.1 data store', async () => {
    const home = await temporaryHome();
    await writeFile(path.join(home, 'catence.duckdb'), 'legacy');
    await expect(initializeCatalog(resolveCatalogPaths(home), { id: 'alex', label: 'Alex' })).rejects.toThrow(
      '0.1 data store'
    );
  });

  it('initializes a home that already holds only Console artifacts', async () => {
    const home = await temporaryHome();
    await writeFile(path.join(home, 'config.json'), '{"console": {"profiles": {}}}');
    await mkdir(path.join(home, 'console'));
    const catalog = await initializeCatalog(resolveCatalogPaths(home), { id: 'alex', label: 'Alex' });
    expect(catalog.defaultAthleteId).toBe('alex');
  });

  it('initializes an empty home', async () => {
    const home = await temporaryHome();
    const catalog = await initializeCatalog(resolveCatalogPaths(home), { id: 'alex', label: 'Alex' });
    expect(catalog.athletes.map((athlete) => athlete.id)).toEqual(['alex']);
  });
});