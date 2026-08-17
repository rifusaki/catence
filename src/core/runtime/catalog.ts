import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CatencePaths } from '../../contracts/runtime.js';
import { resolvePaths } from './configuration.js';

const CATALOG_FORMAT_VERSION = 1;
const athleteIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'must use lowercase letters, digits, and hyphens, starting with a letter');
const catalogSchema = z.object({
  formatVersion: z.literal(CATALOG_FORMAT_VERSION),
  defaultAthleteId: athleteIdSchema,
  athletes: z.array(z.object({
    id: athleteIdSchema,
    label: z.string().trim().min(1).max(120),
    createdAt: z.string().datetime(),
  }).strict()).min(1),
}).strict().superRefine((catalog, context) => {
  const ids = catalog.athletes.map((athlete) => athlete.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['athletes'], message: 'athlete IDs must be unique' });
  if (!ids.includes(catalog.defaultAthleteId)) context.addIssue({ code: 'custom', path: ['defaultAthleteId'], message: 'must name a configured athlete' });
});

export type Athlete = z.infer<typeof catalogSchema>['athletes'][number];
export type CatenceCatalog = z.infer<typeof catalogSchema>;

export type CatalogPaths = {
  root: string;
  catalog: string;
  athletes: string;
  console: string;
};

export function defaultCatalogHome(): string {
  return path.resolve(process.env.CATENCE_HOME ?? path.join(homedir(), '.catence'));
}

export function resolveCatalogPaths(root = defaultCatalogHome()): CatalogPaths {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    catalog: path.join(absoluteRoot, 'catalog.json'),
    athletes: path.join(absoluteRoot, 'athletes'),
    console: path.join(absoluteRoot, 'console'),
  };
}

export function athleteStorePaths(catalogPaths: CatalogPaths, athleteId: string): CatencePaths {
  const id = athleteIdSchema.parse(athleteId);
  return resolvePaths(path.join(catalogPaths.athletes, id));
}

function legacyStoreMessage(paths: CatalogPaths): string {
  return `Catence 0.2 uses a catalog at ${paths.root}. The existing directory looks like a 0.1 data store and cannot be migrated automatically. Create a fresh catalog and re-sync each athlete.`;
}

/** Home-directory entries the Console creates on its own and must not block catalog initialization. */
const CONSOLE_ARTIFACTS = new Set(['config.json', 'console']);

export async function loadCatalog(paths = resolveCatalogPaths()): Promise<CatenceCatalog> {
  const contents = await readFile(paths.catalog, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    if (existsSync(path.join(paths.root, 'catence.duckdb'))) throw new Error(legacyStoreMessage(paths));
    throw new Error(`No Catence catalog exists at ${paths.root}. Run catence-data setup first.`);
  });
  try {
    return catalogSchema.parse(JSON.parse(contents));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Catence catalog at ${paths.catalog}: ${message}`);
  }
}

async function writeCatalog(paths: CatalogPaths, catalog: CatenceCatalog): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.catalog}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, paths.catalog);
}

export async function initializeCatalog(paths = resolveCatalogPaths(), athlete: { id: string; label: string }): Promise<CatenceCatalog> {
  if (existsSync(paths.catalog)) return loadCatalog(paths);
  let entries: string[];
  try {
    entries = await readdir(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw error;
  }
  if (entries.includes('catence.duckdb')) throw new Error(legacyStoreMessage(paths));
  if (entries.some((entry) => !CONSOLE_ARTIFACTS.has(entry))) {
    throw new Error(`Refusing to initialize ${paths.root}: choose an empty --home directory or remove its unrelated contents.`);
  }
  const id = athleteIdSchema.parse(athlete.id);
  const record: Athlete = { id, label: athlete.label.trim(), createdAt: new Date().toISOString() };
  if (!record.label) throw new Error('Athlete label is required.');
  const catalog: CatenceCatalog = { formatVersion: CATALOG_FORMAT_VERSION, defaultAthleteId: id, athletes: [record] };
  await writeCatalog(paths, catalog);
  return catalog;
}

export async function addAthlete(paths: CatalogPaths, athlete: { id: string; label: string; setDefault?: boolean }): Promise<CatenceCatalog> {
  const catalog = await loadCatalog(paths);
  const id = athleteIdSchema.parse(athlete.id);
  if (catalog.athletes.some((entry) => entry.id === id)) throw new Error(`Athlete ${id} already exists.`);
  const label = athlete.label.trim();
  if (!label) throw new Error('Athlete label is required.');
  const next: CatenceCatalog = {
    ...catalog,
    defaultAthleteId: athlete.setDefault ? id : catalog.defaultAthleteId,
    athletes: [...catalog.athletes, { id, label, createdAt: new Date().toISOString() }],
  };
  await writeCatalog(paths, next);
  return next;
}

export async function resolveAthlete(paths: CatalogPaths, athleteId: string): Promise<{ athlete: Athlete; paths: CatencePaths }> {
  const catalog = await loadCatalog(paths);
  const athlete = catalog.athletes.find((entry) => entry.id === athleteId);
  if (!athlete) throw new Error(`Unknown athlete ${athleteId}. Call list_athletes to inspect the configured catalog.`);
  return { athlete, paths: athleteStorePaths(paths, athlete.id) };
}

export async function defaultAthlete(paths = resolveCatalogPaths()): Promise<{ athlete: Athlete; paths: CatencePaths }> {
  const catalog = await loadCatalog(paths);
  return resolveAthlete(paths, catalog.defaultAthleteId);
}
