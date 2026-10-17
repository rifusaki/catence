import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatenceHttpServer } from '../src/interfaces/http/server.js';
import {
  addAthlete,
  addMcpKey,
  athleteStorePaths,
  createDemoStore,
  initializeCatalog,
  resolveCatalogPaths,
  type DetachedSyncHandle,
  type DetachedSyncRequest,
} from '../src/runtime/index.js';

const servers: Array<ReturnType<typeof createCatenceHttpServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: ReturnType<typeof createCatenceHttpServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type Fixture = {
  origin: string;
  home: string;
  tokenFile: string;
  keysFile: string;
  syncCalls: DetachedSyncRequest[];
};

async function scopedFixture(): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), 'catence-gate-scope-'));
  const catalogPaths = resolveCatalogPaths(home);
  await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
  await addAthlete(catalogPaths, { id: 'sam', label: 'Sam' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'alex'), { days: 14, seed: 1, endDate: '2026-08-10' });
  await mkdir(path.join(home, 'console'), { recursive: true });
  await writeFile(path.join(home, 'console', 'accounts.json'), `${JSON.stringify({
    formatVersion: 1,
    accounts: [
      { username: 'boss', passwordHash: '$2b$12$abcdefghijklmnopqrstuv', role: 'admin', athletes: 'all', createdAt: '2026-09-28T12:00:00+00:00' },
      { username: 'martina', passwordHash: '$2b$12$abcdefghijklmnopqrstuv', role: 'member', athletes: ['alex'], createdAt: '2026-09-28T12:00:00+00:00' },
    ],
  }, null, 2)}\n`);
  const tokenFile = path.join(home, 'mcp-token');
  const keysFile = path.join(home, 'mcp-keys.json');
  const syncCalls: DetachedSyncRequest[] = [];
  const server = createCatenceHttpServer({
    catalogPaths,
    bearerTokenFile: tokenFile,
    mcpKeysFile: keysFile,
    startSync: async (request): Promise<DetachedSyncHandle> => {
      syncCalls.push(request);
      return { started: true, athleteId: request.athleteId, provider: request.provider ?? 'all', logFile: 'sync.log' };
    },
  });
  servers.push(server);
  return { origin: await listen(server), home, tokenFile, keysFile, syncCalls };
}

function postJson(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
    body: JSON.stringify(body),
  });
}

describe('HTTP gate with per-account MCP keys', () => {
  it('arms the gate from the key registry and enforces the member athlete scope', async () => {
    const fixture = await scopedFixture();
    const { origin, tokenFile, keysFile, syncCalls } = fixture;

    // No token file and an empty registry: the loopback dev gate stays open.
    expect((await fetch(`${origin}/api/v1/athletes`)).status).toBe(200);

    // The first active key arms the gate without a restart.
    const admin = await addMcpKey(keysFile, { account: 'boss' });
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect((await postJson(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/dashboard?athleteId=alex`)).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer('wrong-token') })).status).toBe(401);

    // The legacy shared token still authenticates as a full-access admin.
    await writeFile(tokenFile, 'legacy-secret');
    const legacyRoster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer('legacy-secret') });
    expect(legacyRoster.status).toBe(200);
    await expect(legacyRoster.json()).resolves.toMatchObject({
      defaultAthleteId: 'alex',
      athletes: [{ id: 'alex', label: 'Alex' }, { id: 'sam', label: 'Sam' }],
    });

    // A member key sees only its granted athlete.
    const member = await addMcpKey(keysFile, { account: 'martina', label: 'Martina phone' });
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(member.token) });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toEqual({
      defaultAthleteId: 'alex',
      athletes: [{ id: 'alex', label: 'Alex', createdAt: expect.any(String) }],
    });

    // In-scope reads work; out-of-scope reads are 403 athlete_forbidden.
    expect((await fetch(`${origin}/api/v1/dashboard?athleteId=alex`, { headers: bearer(member.token) })).status).toBe(200);
    const forbiddenDashboard = await fetch(`${origin}/api/v1/dashboard?athleteId=sam`, { headers: bearer(member.token) });
    expect(forbiddenDashboard.status).toBe(403);
    await expect(forbiddenDashboard.json()).resolves.toMatchObject({ error: { code: 'athlete_forbidden' } });

    const forbiddenSecrets = await fetch(`${origin}/api/v1/athlete-secrets?athleteId=sam`, { headers: bearer(member.token) });
    expect(forbiddenSecrets.status).toBe(403);
    await expect(forbiddenSecrets.json()).resolves.toMatchObject({ error: { code: 'athlete_forbidden' } });

    const forbiddenSync = await postJson(`${origin}/api/v1/sync`, { athleteId: 'sam', provider: 'garmin' }, member.token);
    expect(forbiddenSync.status).toBe(403);
    await expect(forbiddenSync.json()).resolves.toMatchObject({ error: { code: 'athlete_forbidden' } });
    expect(syncCalls).toEqual([]);

    const allowedSync = await postJson(`${origin}/api/v1/sync`, { athleteId: 'alex', provider: 'garmin' }, member.token);
    expect(allowedSync.status).toBe(202);
    expect(syncCalls).toHaveLength(1);

    // Admin-only routes reject a member key with 403 admin_required.
    for (const request of [
      postJson(`${origin}/api/v1/athletes`, { id: 'kim', label: 'Kim' }, member.token),
      postJson(`${origin}/api/v1/mcp-keys`, { account: 'martina' }, member.token),
      postJson(`${origin}/api/v1/models/discover`, {}, member.token),
      fetch(`${origin}/api/v1/mcp-keys`, { headers: bearer(member.token) }),
      fetch(`${origin}/api/v1/mcp-exposure`, { headers: bearer(member.token) }),
      postJson(`${origin}/api/v1/mcp-exposure`, { enabled: true }, member.token),
      fetch(`${origin}/api/v1/mcp-keys?id=${member.record.id}`, { method: 'DELETE', headers: bearer(member.token) }),
      postJson(`${origin}/api/v1/mcp-keys/roll`, { id: member.record.id }, member.token),
    ]) {
      const response = await request;
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'admin_required' } });
    }

    // The admin key passes the same gates.
    expect((await fetch(`${origin}/api/v1/mcp-keys`, { headers: bearer(admin.token) })).status).toBe(200);
    expect((await fetch(`${origin}/api/v1/mcp-exposure`, { headers: bearer(admin.token) })).status).toBe(200);
  });

  it('manages keys over HTTP, returns raw tokens once, and authorizes /mcp', async () => {
    const fixture = await scopedFixture();
    const { origin, keysFile } = fixture;
    const admin = await addMcpKey(keysFile, { account: 'boss' });
    const member = await addMcpKey(keysFile, { account: 'martina' });

    // Listing shows public fields only.
    const listed = await fetch(`${origin}/api/v1/mcp-keys`, { headers: bearer(admin.token) });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { keys: Array<Record<string, unknown>> };
    expect(listedBody.keys).toHaveLength(2);
    expect(listedBody.keys.map((key) => key.id).sort()).toEqual([admin.record.id, member.record.id].sort());
    expect(JSON.stringify(listedBody)).not.toContain('tokenHash');

    // Creating a key returns the raw token once; the file stores only its hash.
    const created = await postJson(`${origin}/api/v1/mcp-keys`, { account: 'martina', label: 'phone' }, admin.token);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; label: string; account: string; createdAt: string; token: string };
    expect(createdBody).toMatchObject({ label: 'phone', account: 'martina' });
    expect(createdBody.token).toMatch(/^[0-9a-f]{64}$/);
    const storedText = await readFile(keysFile, 'utf8');
    expect(storedText).toContain(sha256(createdBody.token));
    expect(storedText).not.toContain(createdBody.token);

    // The returned token authorizes the JSON APIs (scoped to martina) and /mcp.
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(createdBody.token) });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({ defaultAthleteId: 'alex', athletes: [{ id: 'alex' }] });
    const mcp = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(createdBody.token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gate-scope-test', version: '0.1.0' } } }),
    });
    expect(mcp.status).toBe(200);

    // Strict body validation rejects unknown fields and invalid accounts.
    expect((await postJson(`${origin}/api/v1/mcp-keys`, { account: 'martina', extra: true }, admin.token)).status).toBe(400);
    expect((await postJson(`${origin}/api/v1/mcp-keys`, { account: 'bad name!' }, admin.token)).status).toBe(400);
    expect((await postJson(`${origin}/api/v1/mcp-keys/roll`, {}, admin.token)).status).toBe(400);
    expect((await postJson(`${origin}/api/v1/mcp-keys/roll`, { id: 'nope' }, admin.token)).status).toBe(404);

    // Rolling rotates the token: the old one stops resolving, the new one works.
    const rolled = await postJson(`${origin}/api/v1/mcp-keys/roll`, { id: createdBody.id }, admin.token);
    expect(rolled.status).toBe(200);
    const rolledBody = await rolled.json() as { id: string; token: string };
    expect(rolledBody.id).toBe(createdBody.id);
    expect(rolledBody.token).not.toBe(createdBody.token);
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(createdBody.token) })).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(rolledBody.token) })).status).toBe(200);
    expect((await postJson(`${origin}/api/v1/mcp-keys/roll`, { id: 'f'.repeat(32) }, admin.token)).status).toBe(404);

    // DELETE revokes: the member's original token dies immediately.
    const revoked = await fetch(`${origin}/api/v1/mcp-keys?id=${member.record.id}`, { method: 'DELETE', headers: bearer(admin.token) });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: member.record.id });
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(member.token) })).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/mcp-keys?id=${'e'.repeat(32)}`, { method: 'DELETE', headers: bearer(admin.token) })).status).toBe(404);

    // An admin key may still add athletes.
    const added = await postJson(`${origin}/api/v1/athletes`, { id: 'kim', label: 'Kim' }, admin.token);
    expect(added.status).toBe(201);

    // A key whose account is gone from accounts.json fails closed.
    const ghost = await addMcpKey(keysFile, { account: 'ghost' });
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(ghost.token) })).status).toBe(401);
  });

  it('fails closed when the accounts store is malformed', async () => {
    const fixture = await scopedFixture();
    const { origin, home, keysFile } = fixture;
    const admin = await addMcpKey(keysFile, { account: 'boss' });
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(admin.token) })).status).toBe(200);

    // A malformed accounts store resolves no key principal (401, never 500).
    await writeFile(path.join(home, 'console', 'accounts.json'), '{ not json');
    const rejected = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(admin.token) });
    expect(rejected.status).toBe(401);

    // An admin holding a grant list instead of "all" keeps the list (fail safe).
    await writeFile(path.join(home, 'console', 'accounts.json'), `${JSON.stringify({
      formatVersion: 1,
      accounts: [
        { username: 'boss', passwordHash: '$2b$12$abcdefghijklmnopqrstuv', role: 'admin', athletes: ['sam'], createdAt: '2026-09-28T12:00:00+00:00' },
      ],
    })}\n`);
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(admin.token) });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({
      defaultAthleteId: 'sam',
      athletes: [{ id: 'sam', label: 'Sam' }],
    });
    // The admin role still passes the admin-only gates.
    expect((await fetch(`${origin}/api/v1/mcp-keys`, { headers: bearer(admin.token) })).status).toBe(200);
  });
});
