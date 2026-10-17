import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ConsoleAccountScope } from './console-accounts.js';

const MCP_KEYS_FORMAT_VERSION = 1;
const accountSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1-64 characters of letters, digits, dots, underscores, or hyphens');
const keySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-character hex id'),
  label: z.string().trim().min(1).max(120),
  account: accountSchema,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest'),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
}).strict();
const registrySchema = z.object({
  formatVersion: z.literal(MCP_KEYS_FORMAT_VERSION),
  keys: z.array(keySchema),
}).strict();

/** The stored key record; tokenHash is the SHA-256 hex digest of the raw token. */
export type McpKeyRecord = z.infer<typeof keySchema>;
/** The public key view: the stored record without the token hash. */
export type McpKeySummary = Omit<McpKeyRecord, 'tokenHash'>;
export type McpKeyRegistry = z.infer<typeof registrySchema>;
export type McpKeyPrincipal = ConsoleAccountScope & { account: string };

export class McpKeyNotFoundError extends Error {}

type AccountScopeResolver = (username: string) => ConsoleAccountScope | null;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('hex');
}

function newKeyId(): string {
  return randomBytes(16).toString('hex');
}

function emptyRegistry(): McpKeyRegistry {
  return { formatVersion: MCP_KEYS_FORMAT_VERSION, keys: [] };
}

/** Strict registry read for mutations and listings: malformed fails loudly. */
async function loadRegistry(keysFile: string): Promise<McpKeyRegistry> {
  const contents = await readFile(keysFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (contents === null) return emptyRegistry();
  try {
    return registrySchema.parse(JSON.parse(contents));
  } catch (error) {
    throw new Error(`Invalid MCP key registry at ${keysFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeRegistry(keysFile: string, registry: McpKeyRegistry): Promise<void> {
  await mkdir(path.dirname(keysFile), { recursive: true, mode: 0o700 });
  const temporary = `${keysFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, keysFile);
}

type CachedRegistry = { mtimeMs: number; registry: McpKeyRegistry | null };
const registryCache = new Map<string, CachedRegistry>();

/**
 * The parsed registry for resolution, cached by file mtime so revocations and
 * rollovers are picked up without a restart. A missing file is an empty
 * registry; an unreadable or malformed one resolves to null (fail closed).
 */
function readRegistryCached(keysFile: string): McpKeyRegistry | null {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(keysFile).mtimeMs;
  } catch {
    registryCache.set(keysFile, { mtimeMs: 0, registry: emptyRegistry() });
    return emptyRegistry();
  }
  const cached = registryCache.get(keysFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.registry;
  let registry: McpKeyRegistry | null = null;
  try {
    registry = registrySchema.parse(JSON.parse(readFileSync(keysFile, 'utf8')));
  } catch {
    registry = null;
  }
  registryCache.set(keysFile, { mtimeMs, registry });
  return registry;
}

/** The number of non-revoked keys; a missing or malformed registry counts zero. */
export function countActiveMcpKeys(keysFile: string): number {
  const registry = readRegistryCached(keysFile);
  if (!registry) return 0;
  return registry.keys.filter((key) => key.revokedAt === undefined).length;
}

function findKey(registry: McpKeyRegistry, id: string): McpKeyRecord {
  const key = registry.keys.find((entry) => entry.id === id);
  if (!key) throw new McpKeyNotFoundError(`Unknown MCP key ${id}.`);
  return key;
}

/**
 * Create a per-account key. The raw token is generated here, stored only as a
 * SHA-256 hex digest, and returned exactly once.
 */
export async function addMcpKey(keysFile: string, input: { account: string; label?: string }): Promise<{ record: McpKeyRecord; token: string }> {
  const account = accountSchema.parse(input.account);
  const label = (input.label ?? `${account} key`).trim();
  if (!label) throw new Error('Key label is required.');
  if (label.length > 120) throw new Error('Key label must be at most 120 characters.');
  const registry = await loadRegistry(keysFile);
  const id = newKeyId();
  if (registry.keys.some((key) => key.id === id)) throw new Error(`MCP key id ${id} already exists.`);
  const token = newToken();
  const record: McpKeyRecord = { id, label, account, tokenHash: hashToken(token), createdAt: new Date().toISOString() };
  await writeRegistry(keysFile, { ...registry, keys: [...registry.keys, record] });
  return { record, token };
}

/** All keys without their token hashes; a missing registry lists as empty. */
export async function listMcpKeys(keysFile: string): Promise<McpKeySummary[]> {
  const registry = await loadRegistry(keysFile);
  return registry.keys.map(({ tokenHash: _tokenHash, ...summary }) => summary);
}

/** Revoke a key by id. Revoking an already-revoked key is a no-op. */
export async function revokeMcpKey(keysFile: string, id: string): Promise<McpKeyRecord> {
  const registry = await loadRegistry(keysFile);
  const key = findKey(registry, id);
  if (key.revokedAt !== undefined) return key;
  const revoked: McpKeyRecord = { ...key, revokedAt: new Date().toISOString() };
  await writeRegistry(keysFile, { ...registry, keys: registry.keys.map((entry) => (entry.id === id ? revoked : entry)) });
  return revoked;
}

/**
 * Replace a key's token: same id, account, and label, revokedAt cleared, and a
 * new raw token returned exactly once. The previous token stops resolving.
 */
export async function rollMcpKey(keysFile: string, id: string): Promise<{ record: McpKeyRecord; token: string }> {
  const registry = await loadRegistry(keysFile);
  const key = findKey(registry, id);
  const token = newToken();
  const rolled: McpKeyRecord = { ...key, tokenHash: hashToken(token), revokedAt: undefined };
  await writeRegistry(keysFile, { ...registry, keys: registry.keys.map((entry) => (entry.id === id ? rolled : entry)) });
  return { record: rolled, token };
}

/**
 * Resolve a raw bearer token to the key's account principal, or null when the
 * token matches nothing. Comparison is timing-safe over the fixed-length
 * SHA-256 hex digests. Fail closed: an unreadable or malformed registry, a
 * revoked key, or a key whose account no longer exists all resolve to null.
 */
export function resolveKeyPrincipal(keysFile: string, rawToken: string, resolveAccount: AccountScopeResolver): McpKeyPrincipal | null {
  if (!rawToken) return null;
  const registry = readRegistryCached(keysFile);
  if (!registry) return null;
  const received = Buffer.from(hashToken(rawToken), 'utf8');
  for (const key of registry.keys) {
    if (key.revokedAt !== undefined) continue;
    const expected = Buffer.from(key.tokenHash, 'utf8');
    // timingSafeEqual throws on length mismatch, so compare sizes first.
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) continue;
    const scope = resolveAccount(key.account);
    if (!scope) return null;
    return { account: key.account, role: scope.role, athleteIds: scope.athleteIds };
  }
  return null;
}
