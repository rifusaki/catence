import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePaths, resolvePaths, type CatencePaths } from '../src/core/runtime/configuration.js';
import {
  ATHLETE_FILE_MAX_CHARACTERS,
  ATHLETE_FILE_TEMPLATE,
  AthleteFileConflictError,
  AthleteFileTooLargeError,
  AthleteFileValidationError,
  hashAthleteFileContent,
  listAthleteFileRevisions,
  readAthleteFile,
  readAthleteFileRevision,
  updateAthleteFile,
} from '../src/runtime/index.js';

async function temporaryStore(): Promise<CatencePaths> {
  const root = await mkdtemp(path.join(tmpdir(), 'catence-athlete-file-'));
  const paths = resolvePaths(root);
  await ensurePaths(paths);
  return paths;
}

describe('athlete file', () => {
  it('returns the template with a null hash while the file does not exist', async () => {
    const paths = await temporaryStore();
    const snapshot = await readAthleteFile(paths);
    expect(snapshot).toEqual({ exists: false, content: ATHLETE_FILE_TEMPLATE, hash: null, updatedAt: null });
  });

  it('creates the file with expectedHash null and reports the new hash', async () => {
    const paths = await temporaryStore();
    const content = '# Athlete file\n\n## Goals\n\n- Sub-40 10k\n';
    const created = await updateAthleteFile(paths, { operation: 'replace', content, expectedHash: null });
    expect(created.exists).toBe(true);
    expect(created.content).toBe(content);
    expect(created.hash).toBe(hashAthleteFileContent(content));
    expect(created.updatedAt).not.toBeNull();

    const reread = await readAthleteFile(paths);
    expect(reread).toEqual(created);
  });

  it('rejects writes whose expected hash no longer matches', async () => {
    const paths = await temporaryStore();
    const first = await updateAthleteFile(paths, { operation: 'replace', content: 'first\n', expectedHash: null });
    const advanced = await updateAthleteFile(paths, { operation: 'append', content: 'second\n', expectedHash: first.hash });
    const attempt = (hash: string | null) => updateAthleteFile(paths, { operation: 'append', content: 'third\n', expectedHash: hash }).catch((error: unknown) => error);

    const staleAgainstOld = await attempt(first.hash);
    expect(staleAgainstOld).toBeInstanceOf(AthleteFileConflictError);
    expect((staleAgainstOld as AthleteFileConflictError).currentHash).toBe(advanced.hash);
    expect((staleAgainstOld as AthleteFileConflictError).currentContent).toBe(advanced.content);

    // A create attempt against an existing file is a conflict too.
    const staleCreate = await attempt(null);
    expect(staleCreate).toBeInstanceOf(AthleteFileConflictError);
    expect((staleCreate as AthleteFileConflictError).currentHash).toBe(advanced.hash);
  });

  it('appends content and snapshots the prior revision', async () => {
    const paths = await temporaryStore();
    const created = await updateAthleteFile(paths, { operation: 'replace', content: '## Notes\n\n- first\n', expectedHash: null });
    const appended = await updateAthleteFile(paths, { operation: 'append', content: '## New section\n\n- second', expectedHash: created.hash });
    expect(appended.content).toBe('## Notes\n\n- first\n\n## New section\n\n- second\n');

    const revisions = await listAthleteFileRevisions(paths);
    expect(revisions).toHaveLength(1);
    // Revision hashes are the eight-character content-hash prefix stored in the file name.
    expect(created.hash!.startsWith(revisions[0]!.hash)).toBe(true);
    await expect(readAthleteFileRevision(paths, revisions[0]!.revisionId)).resolves.toBe('## Notes\n\n- first\n');
  });

  it('replaces an existing section body and creates missing sections', async () => {
    const paths = await temporaryStore();
    const created = await updateAthleteFile(paths, {
      operation: 'replace',
      content: '# Athlete file\n\n## Profile\n\n- old profile\n\n## Goals\n\n- old goal\n',
      expectedHash: null,
    });
    const replaced = await updateAthleteFile(paths, { operation: 'replace_section', section: 'Profile', content: '- new profile', expectedHash: created.hash });
    expect(replaced.content).toBe('# Athlete file\n\n## Profile\n\n- new profile\n\n## Goals\n\n- old goal\n');

    const createdSection = await updateAthleteFile(paths, { operation: 'replace_section', section: 'Preferences', content: '- metric units', expectedHash: replaced.hash });
    expect(createdSection.content).toBe('# Athlete file\n\n## Profile\n\n- new profile\n\n## Goals\n\n- old goal\n\n## Preferences\n\n- metric units\n');
  });

  it('normalizes CRLF line endings', async () => {
    const paths = await temporaryStore();
    const created = await updateAthleteFile(paths, { operation: 'replace', content: 'line one\r\nline two\r\n', expectedHash: null });
    expect(created.content).toBe('line one\nline two\n');
    expect(created.content).not.toContain('\r');
  });

  it('enforces the character cap', async () => {
    const paths = await temporaryStore();
    const tooLong = 'x'.repeat(ATHLETE_FILE_MAX_CHARACTERS + 1);
    await expect(updateAthleteFile(paths, { operation: 'replace', content: tooLong, expectedHash: null })).rejects.toBeInstanceOf(AthleteFileTooLargeError);
  });

  it('validates operations and empty content', async () => {
    const paths = await temporaryStore();
    await expect(updateAthleteFile(paths, { operation: 'replace', content: '   ', expectedHash: null })).rejects.toBeInstanceOf(AthleteFileValidationError);
    await expect(updateAthleteFile(paths, { operation: 'replace_section', section: '  ', content: 'x', expectedHash: null })).rejects.toBeInstanceOf(AthleteFileValidationError);
    await expect(updateAthleteFile(paths, { operation: 'bogus' as never, content: 'x', expectedHash: null })).rejects.toBeInstanceOf(AthleteFileValidationError);
  });

  it('keeps a rolling window of the ten newest revisions', async () => {
    const paths = await temporaryStore();
    let hash: string | null = null;
    for (let index = 0; index < 12; index += 1) {
      const snapshot = await updateAthleteFile(paths, { operation: 'replace', content: `revision ${index}\n`, expectedHash: hash });
      hash = snapshot.hash;
    }
    const revisions = await listAthleteFileRevisions(paths);
    expect(revisions).toHaveLength(10);
    expect(revisions[0]!.savedAt >= revisions[9]!.savedAt).toBe(true);
    // Set comparison keeps the assertion deterministic even when two writes
    // land in the same millisecond. Revision 0 was pruned; revision 11 is the
    // head and was never snapshotted.
    const contents = await Promise.all(revisions.map((revision) => readAthleteFileRevision(paths, revision.revisionId)));
    expect(new Set(contents)).toEqual(new Set(Array.from({ length: 10 }, (_, index) => `revision ${index + 1}\n`)));
    await expect(readAthleteFileRevision(paths, 'not-a-revision')).rejects.toBeInstanceOf(AthleteFileValidationError);
    await expect(readAthleteFileRevision(paths, '1700000000000-deadbeef.md')).resolves.toBeNull();
  });
});
