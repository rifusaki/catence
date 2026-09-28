import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../../contracts/runtime.js';

/**
 * One athlete-authored markdown document per athlete store. Both the athlete
 * (Console/UI) and the agent (MCP tools) may write it; every write is guarded
 * by an optimistic compare-and-swap on the sha256 of the current content so
 * neither side silently clobbers the other. Prior content is snapshotted into
 * a small rolling revision history.
 */
export const ATHLETE_FILE_MAX_CHARACTERS = 32_768;

const ATHLETE_FILE_HISTORY_LIMIT = 10;
const REVISION_PATTERN = /^(\d{1,20})-([0-9a-f]{8})\.md$/;

export const ATHLETE_FILE_TEMPLATE = `# Athlete file

This file is shared by the athlete and the Catence agent. Keep durable facts here:
profile, goals, constraints, injuries, preferences, and standing notes.
Do not store credentials, provider configuration, or transient daily status.

## Profile

## Goals

## Constraints and injuries

## Preferences

## Notes
`;

export type AthleteFileSnapshot = {
  exists: boolean;
  /** Stored content, or the starter template while the file does not exist yet. */
  content: string;
  /** sha256 of the stored content; null while the file does not exist. */
  hash: string | null;
  updatedAt: string | null;
};

export type AthleteFileOperation = 'replace' | 'append' | 'replace_section';

export type AthleteFileUpdate = {
  operation: AthleteFileOperation;
  /** Required when operation is replace_section. */
  section?: string;
  content: string;
  /** Hash the caller read before this update; null when creating the file. */
  expectedHash: string | null;
};

export type AthleteFileRevision = {
  revisionId: string;
  hash: string;
  savedAt: string;
};

export class AthleteFileConflictError extends Error {
  constructor(readonly currentHash: string, readonly currentContent: string) {
    super('The athlete file changed since it was read. Read it again before writing.');
    this.name = 'AthleteFileConflictError';
  }
}

export class AthleteFileTooLargeError extends Error {
  constructor(readonly characters: number) {
    super(`Athlete file would be ${characters} characters; the limit is ${ATHLETE_FILE_MAX_CHARACTERS}. Shorten the write or split it into sections.`);
    this.name = 'AthleteFileTooLargeError';
  }
}

export class AthleteFileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AthleteFileValidationError';
  }
}

export function hashAthleteFileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeContent(content: string): string {
  return `${content.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applySection(content: string, section: string, replacement: string): string {
  const name = section.trim();
  if (!name) throw new AthleteFileValidationError('replace_section requires a non-empty section name.');
  const body = normalizeContent(replacement).trim();
  const match = new RegExp(`^##\\s+${escapeRegExp(name)}\\s*$`, 'im').exec(content);
  if (!match) {
    const base = normalizeContent(content).trimEnd();
    return body ? `${base}\n\n## ${name}\n\n${body}\n` : `${base}\n\n## ${name}\n`;
  }
  const bodyStart = content.indexOf('\n', match.index) + 1;
  const rest = content.slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(rest);
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : content.length;
  const before = content.slice(0, bodyStart);
  const after = content.slice(bodyEnd).replace(/^\n+/, '');
  const combined = body ? `${before}\n${body}\n\n${after}` : `${before}\n${after}`;
  return normalizeContent(combined).replace(/\n{3,}/g, '\n\n');
}

export async function readAthleteFile(paths: CatencePaths): Promise<AthleteFileSnapshot> {
  let stored: string | null;
  try {
    stored = await readFile(paths.athleteFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stored = null;
  }
  if (stored === null) return { exists: false, content: ATHLETE_FILE_TEMPLATE, hash: null, updatedAt: null };
  const content = normalizeContent(stored);
  const stats = await stat(paths.athleteFile);
  return { exists: true, content, hash: hashAthleteFileContent(content), updatedAt: stats.mtime.toISOString() };
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function listRevisionNames(paths: CatencePaths): Promise<Array<{ name: string; epoch: number }>> {
  const names = await readdir(paths.athleteFileHistory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return names
    .map((name) => ({ name, match: REVISION_PATTERN.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map((entry) => ({ name: entry.name, epoch: Number(entry.match[1]) }))
    .sort((left, right) => right.epoch - left.epoch);
}

async function snapshotRevision(paths: CatencePaths, content: string): Promise<void> {
  await mkdir(paths.athleteFileHistory, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${hashAthleteFileContent(content).slice(0, 8)}.md`;
  await writeFile(path.join(paths.athleteFileHistory, name), content, { encoding: 'utf8', mode: 0o600 });
  const revisions = await listRevisionNames(paths);
  for (const stale of revisions.slice(ATHLETE_FILE_HISTORY_LIMIT)) {
    await unlink(path.join(paths.athleteFileHistory, stale.name)).catch(() => undefined);
  }
}

export async function updateAthleteFile(paths: CatencePaths, update: AthleteFileUpdate): Promise<AthleteFileSnapshot> {
  if (!['replace', 'append', 'replace_section'].includes(update.operation)) {
    throw new AthleteFileValidationError(`Unknown athlete-file operation: ${String(update.operation)}.`);
  }
  const sparse = update.content.trim();
  if (update.operation !== 'replace_section' && !sparse) {
    throw new AthleteFileValidationError(`${update.operation} requires non-empty content.`);
  }
  const current = await readAthleteFile(paths);
  if (current.hash !== update.expectedHash) {
    throw new AthleteFileConflictError(current.hash ?? 'absent', current.content);
  }
  let next: string;
  if (update.operation === 'replace') next = normalizeContent(update.content);
  else if (update.operation === 'append') next = normalizeContent(`${current.content.trimEnd()}\n\n${update.content.trim()}`);
  else next = applySection(current.content, update.section ?? '', update.content);
  next = normalizeContent(next);
  if (next.length > ATHLETE_FILE_MAX_CHARACTERS) throw new AthleteFileTooLargeError(next.length);
  if (current.exists) await snapshotRevision(paths, current.content);
  await writeAtomically(paths.athleteFile, next);
  return readAthleteFile(paths);
}

export async function listAthleteFileRevisions(paths: CatencePaths): Promise<AthleteFileRevision[]> {
  const revisions = await listRevisionNames(paths);
  return revisions.map((revision) => ({
    revisionId: revision.name,
    hash: REVISION_PATTERN.exec(revision.name)![2]!,
    savedAt: new Date(revision.epoch).toISOString(),
  }));
}

export async function readAthleteFileRevision(paths: CatencePaths, revisionId: string): Promise<string | null> {
  if (!REVISION_PATTERN.test(revisionId)) throw new AthleteFileValidationError('Unknown athlete-file revision identifier.');
  try {
    return normalizeContent(await readFile(path.join(paths.athleteFileHistory, revisionId), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
