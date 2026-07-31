import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../../contracts/runtime.js';
import type { Provider } from '../../contracts/staging.js';

function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown';
}

export function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Stable object hash used to decide whether expensive activity children changed. */
export function stableJsonHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export type StoredArtifact = {
  contentHash: string;
  relativePath: string;
  contentType: string;
};

export async function storeArtifact(
  paths: CatencePaths,
  provider: Provider,
  endpoint: string,
  remoteId: string | null,
  contents: string | Uint8Array,
  extension: string,
  contentType: string,
): Promise<StoredArtifact> {
  const contentHash = sha256(contents);
  const relativePath = path.join(provider, safeSegment(endpoint), safeSegment(remoteId ?? 'collection'), `${contentHash}.${extension}`);
  const destination = path.join(paths.raw, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await readFile(destination);
  } catch {
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  }
  return { contentHash, relativePath: path.join('raw', relativePath), contentType };
}

export async function storeJsonArtifact(
  paths: CatencePaths,
  provider: Provider,
  endpoint: string,
  remoteId: string | null,
  payload: unknown,
): Promise<StoredArtifact> {
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  return storeArtifact(paths, provider, endpoint, remoteId, contents, 'json', 'application/json');
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readFile(filePath, 'utf8').catch(() => '');
  await writeFile(filePath, `${existing}${JSON.stringify(value)}\n`);
}
