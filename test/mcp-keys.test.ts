import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addMcpKey,
  countActiveMcpKeys,
  listMcpKeys,
  McpKeyNotFoundError,
  resolveKeyPrincipal,
  revokeMcpKey,
  rollMcpKey,
  type ConsoleAccountScope,
} from '../src/runtime/index.js';

async function temporaryKeysFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'catence-mcp-keys-'));
  return path.join(directory, 'mcp-keys.json');
}

const martinaScope: ConsoleAccountScope = { role: 'member', athleteIds: ['alex'] };
const resolveMartina = (username: string): ConsoleAccountScope | null => (username === 'martina' ? martinaScope : null);

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

describe('MCP key registry', () => {
  it('adds, lists, revokes, and rolls keys while storing only token hashes', async () => {
    const keysFile = await temporaryKeysFile();
    const added = await addMcpKey(keysFile, { account: 'martina' });
    expect(added.token).toMatch(/^[0-9a-f]{64}$/);
    expect(added.record).toMatchObject({ account: 'martina', label: 'martina key' });
    expect(added.record.revokedAt).toBeUndefined();

    // The raw token appears nowhere on disk; only its SHA-256 hex digest does.
    const storedText = await readFile(keysFile, 'utf8');
    expect(storedText).not.toContain(added.token);
    const stored = JSON.parse(storedText) as { formatVersion: number; keys: Array<Record<string, unknown>> };
    expect(stored.formatVersion).toBe(1);
    expect(stored.keys).toHaveLength(1);
    expect(stored.keys[0]).toMatchObject({ id: added.record.id, account: 'martina', tokenHash: sha256(added.token) });
    expect((await stat(keysFile)).mode & 0o777).toBe(0o600);
    // The atomic tmp+rename write leaves no temporary files behind.
    expect((await readdir(path.dirname(keysFile))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

    // Listing returns the public shape: no hashes.
    const listed = await listMcpKeys(keysFile);
    expect(listed).toEqual([{ id: added.record.id, label: 'martina key', account: 'martina', createdAt: added.record.createdAt }]);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');

    expect(countActiveMcpKeys(keysFile)).toBe(1);

    // Revoke stops resolution immediately.
    const revoked = await revokeMcpKey(keysFile, added.record.id);
    expect(revoked.revokedAt).toEqual(expect.any(String));
    expect(resolveKeyPrincipal(keysFile, added.token, resolveMartina)).toBeNull();
    expect(countActiveMcpKeys(keysFile)).toBe(0);
    // Revoking an already-revoked key is a no-op; an unknown id fails loudly.
    await expect(revokeMcpKey(keysFile, added.record.id)).resolves.toMatchObject({ id: added.record.id });
    await expect(revokeMcpKey(keysFile, '0'.repeat(32))).rejects.toBeInstanceOf(McpKeyNotFoundError);

    // Roll keeps id/account/label, clears revokedAt, and rotates the token.
    const rolled = await rollMcpKey(keysFile, added.record.id);
    expect(rolled.token).not.toBe(added.token);
    expect(rolled.record).toMatchObject({ id: added.record.id, account: 'martina', label: 'martina key', createdAt: added.record.createdAt });
    expect(rolled.record.revokedAt).toBeUndefined();
    expect(resolveKeyPrincipal(keysFile, added.token, resolveMartina)).toBeNull();
    expect(resolveKeyPrincipal(keysFile, rolled.token, resolveMartina)).toEqual({ account: 'martina', role: 'member', athleteIds: ['alex'] });
    expect(countActiveMcpKeys(keysFile)).toBe(1);
    await expect(rollMcpKey(keysFile, '1'.repeat(32))).rejects.toBeInstanceOf(McpKeyNotFoundError);
  });

  it('resolves key principals and fails closed on unknown tokens, revoked keys, and unknown accounts', async () => {
    const keysFile = await temporaryKeysFile();
    const { record, token } = await addMcpKey(keysFile, { account: 'martina', label: 'phone' });

    expect(resolveKeyPrincipal(keysFile, token, resolveMartina)).toEqual({ account: 'martina', role: 'member', athleteIds: ['alex'] });
    expect(resolveKeyPrincipal(keysFile, 'f'.repeat(64), resolveMartina)).toBeNull();
    expect(resolveKeyPrincipal(keysFile, '', resolveMartina)).toBeNull();
    // The account resolver is authoritative: a key for a deleted account fails closed.
    expect(resolveKeyPrincipal(keysFile, token, () => null)).toBeNull();

    await revokeMcpKey(keysFile, record.id);
    expect(resolveKeyPrincipal(keysFile, token, resolveMartina)).toBeNull();
  });

  it('fails closed when the registry is missing or malformed', async () => {
    const keysFile = await temporaryKeysFile();
    expect(resolveKeyPrincipal(keysFile, 'a'.repeat(64), resolveMartina)).toBeNull();
    expect(countActiveMcpKeys(keysFile)).toBe(0);
    await expect(listMcpKeys(keysFile)).resolves.toEqual([]);

    await writeFile(keysFile, 'not json at all');
    expect(resolveKeyPrincipal(keysFile, 'a'.repeat(64), resolveMartina)).toBeNull();
    expect(countActiveMcpKeys(keysFile)).toBe(0);
    await expect(listMcpKeys(keysFile)).rejects.toThrow('Invalid MCP key registry');

    // A structurally wrong registry (unknown field) is malformed too.
    await writeFile(keysFile, JSON.stringify({ formatVersion: 1, keys: [{ id: 'x' }] }));
    expect(resolveKeyPrincipal(keysFile, 'a'.repeat(64), resolveMartina)).toBeNull();
    await expect(addMcpKey(keysFile, { account: 'martina' })).rejects.toThrow('Invalid MCP key registry');
  });

  it('validates account names and labels at the boundary', async () => {
    const keysFile = await temporaryKeysFile();
    await expect(addMcpKey(keysFile, { account: 'bad name!' })).rejects.toThrow();
    await expect(addMcpKey(keysFile, { account: 'x'.repeat(65) })).rejects.toThrow();
    await expect(addMcpKey(keysFile, { account: 'martina', label: 'y'.repeat(121) })).rejects.toThrow('at most 120');
    await expect(addMcpKey(keysFile, { account: 'martina', label: '   ' })).rejects.toThrow('label is required');
    expect(countActiveMcpKeys(keysFile)).toBe(0);
  });
});
