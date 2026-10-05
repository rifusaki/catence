import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CATENCE_PROTOCOL_VERSION, CATENCE_RUNTIME_VERSION } from '../src/contracts/release.js';
import { createCatenceHttpServer } from '../src/interfaces/http/server.js';
import { initializeCatalog, resolveCatalogPaths, startDetachedSync, ATHLETE_FILE_TEMPLATE, type DetachedSyncHandle, type DetachedSyncRequest } from '../src/runtime/index.js';
import { temporaryDatabase } from './helpers.js';

const servers: Array<ReturnType<typeof createCatenceHttpServer>> = [];

function fakeStartSync(log = 'log.txt'): (request: DetachedSyncRequest) => Promise<DetachedSyncHandle> {
  return async (request) => ({ started: true, athleteId: request.athleteId, provider: request.provider ?? 'all', logFile: log });
}

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Catence Streamable HTTP server', () => {
  it('serves health and the existing MCP catalog', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const server = createCatenceHttpServer({ paths, allowedOrigins: ['http://127.0.0.1:8000'] });
    servers.push(server);
    const origin = await listen(server);

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: 'ok',
      service: 'catence',
      runtimeVersion: CATENCE_RUNTIME_VERSION,
      protocolVersion: CATENCE_PROTOCOL_VERSION,
      capabilities: { mcp: true, dashboardApi: 1, demoStore: true },
    });

    const dashboard = await fetch(`${origin}/api/v1/dashboard?endDate=2026-08-09&days=7`);
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toEqual(expect.objectContaining({
      period: { startDate: '2026-08-03', endDate: '2026-08-09', days: 7 },
      health: [],
      training: { weeks: [] },
      activities: [],
    }));

    const client = new Client({ name: 'catence-http-test-client', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['catence_status', 'describe_data', 'read_series']));
    } finally {
      await client.close();
    }
  });

  it('enforces the configured browser origins', async () => {
    const server = createCatenceHttpServer({ allowedOrigins: ['http://127.0.0.1:8000'] });
    servers.push(server);
    const origin = await listen(server);

    const rejected = await fetch(`${origin}/health`, { headers: { origin: 'http://example.test' } });
    expect(rejected.status).toBe(403);
    const allowed = await fetch(`${origin}/health`, { headers: { origin: 'http://127.0.0.1:8000' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8000');

    const invalidDashboard = await fetch(`${origin}/api/v1/dashboard?days=0`);
    expect(invalidDashboard.status).toBe(400);
  });

  it('creates catalog athletes through POST /api/v1/athletes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-athletes-http-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const server = createCatenceHttpServer({ catalogPaths });
    servers.push(server);
    const origin = await listen(server);

    const roster = await fetch(`${origin}/api/v1/athletes`);
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({
      defaultAthleteId: 'alex',
      athletes: [{ id: 'alex', label: 'Alex' }],
    });

    const invalid = await fetch(`${origin}/api/v1/athletes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'Not Valid', label: 'Nobody' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'athlete_create_failed' } });

    const created = await fetch(`${origin}/api/v1/athletes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sam', label: 'Sam', setDefault: true }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      defaultAthleteId: 'sam',
      athletes: [
        { id: 'alex', label: 'Alex' },
        { id: 'sam', label: 'Sam' },
      ],
    });

    const duplicate = await fetch(`${origin}/api/v1/athletes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sam', label: 'Sam again' }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: 'athlete_exists' } });

    // A single-store (legacy) server has no catalog to extend.
    const legacyFixture = await temporaryDatabase();
    await legacyFixture.database.close();
    const legacy = createCatenceHttpServer({ paths: legacyFixture.paths });
    servers.push(legacy);
    const legacyOrigin = await listen(legacy);
    const rejected = await fetch(`${legacyOrigin}/api/v1/athletes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sam', label: 'Sam' }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'catalog_required' } });
  });

  it('starts detached syncs and reports progress plus last-completion timestamps', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    let requested: DetachedSyncRequest | null = null;
    const server = createCatenceHttpServer({
      paths,
      startSync: async (request) => {
        requested = request;
        return { started: true, athleteId: request.athleteId, provider: request.provider ?? 'all', logFile: 'sync.log' };
      },
      mergeModels: async ({ configPath }) => ({
        configPath,
        mergedProfileIds: ['opencode-go'],
        defaultProfile: 'opencode-go',
        counts: { chat: 3, responses: 1, messages: 2 },
        guessedRoutes: [],
      }),
    });
    servers.push(server);
    const origin = await listen(server);

    const invalid = await fetch(`${origin}/api/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'bogus' }),
    });
    expect(invalid.status).toBe(400);

    const started = await fetch(`${origin}/api/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'garmin', refresh: true, refreshModels: true }),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      started: true,
      athleteId: 'local',
      provider: 'garmin',
      progressEndpoint: '/api/v1/sync/status',
    });
    // The discovery merge receives the store's config path.
    expect((requested as unknown as DetachedSyncRequest | null)).toMatchObject({ athleteId: 'local', provider: 'garmin', refresh: true });

    const status = await fetch(`${origin}/api/v1/sync/status`);
    expect(status.status).toBe(200);
    // An empty readable store reports a null last-completion timestamp; while
    // a sync holds the write lock, lastSync is null entirely.
    expect(await status.json()).toMatchObject({
      athleteId: 'local',
      progress: { running: [], recent: [] },
      lastSync: { lastCompletedAt: null, providers: {} },
    });
  });

  it('populates lastSync from completed runs via the read-only repository', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.run(
      `INSERT INTO sync_runs (run_id, provider, from_date, started_at, completed_at, status, parser_version)
       VALUES ($runId, 'garmin', '2026-08-01', now(), now(), 'completed', 1)`,
      { runId: 'completed-run-1' },
    );
    await database.close();

    const server = createCatenceHttpServer({ paths });
    servers.push(server);
    const origin = await listen(server);

    const response = await fetch(`${origin}/api/v1/sync/status`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      lastSync: { lastCompletedAt: string | null; providers: Record<string, string> };
    };
    expect(payload.lastSync.providers.garmin).toBeTruthy();
    expect(payload.lastSync.lastCompletedAt).toBe(payload.lastSync.providers.garmin);
  });

  it('reports 409 with a stable error code when a sync run is already active', async () => {    const { paths, database } = await temporaryDatabase();
    await database.close();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(paths.staging, 'garmin'), { recursive: true });
    await writeFile(
      path.join(paths.staging, 'garmin', 'run-1.progress.json'),
      JSON.stringify({ runId: 'run-1', provider: 'garmin', stage: 'daily', completedUnits: 0, totalUnits: null, percentComplete: 0, elapsedSeconds: 0, estimatedRemainingSeconds: null, heartbeatAt: new Date().toISOString() }),
      'utf8',
    );

    // The default startDetachedSync performs the busy check itself, so the
    // server must refuse before any spawn dependency runs.
    let spawned = false;
    const server = createCatenceHttpServer({
      paths,
      syncSpawnProcess: () => {
        spawned = true;
        return { unref() {} };
      },
    });    servers.push(server);
    const origin = await listen(server);

    const response = await fetch(`${origin}/api/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'sync_in_progress', message: expect.stringContaining('run-1') } });
    expect(spawned).toBe(false);

    const status = await fetch(`${origin}/api/v1/sync/status`);
    // The store itself stays readable here: the sidecar simulates live
    // progress without holding the real single-writer lock.
    expect(await status.json()).toMatchObject({ progress: { running: [{ runId: 'run-1' }] }, lastSync: { lastCompletedAt: null } });
  });

  it('keeps model-discovery failures non-fatal for the data sync', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const server = createCatenceHttpServer({
      paths,
      startSync: fakeStartSync(),
      mergeModels: async () => {
        throw new Error('catalog unreachable');
      },
    });
    servers.push(server);
    const origin = await listen(server);

    const started = await fetch(`${origin}/api/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshModels: true }),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      started: true,
      warning: expect.stringContaining('OpenCode Go model discovery failed'),
    });
  });

  it('never reports a finished run as active, even when its sidecar survived', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(paths.staging, 'garmin'), { recursive: true });
    // A terminal heartbeat that outlived its own cleanup (the historic
    // publish/remove race) must not read as a running sync.
    await writeFile(
      path.join(paths.staging, 'garmin', 'done-1.progress.json'),
      JSON.stringify({ runId: 'done-1', provider: 'intervals', stage: 'completed', completedUnits: 0, totalUnits: null, percentComplete: 0, elapsedSeconds: 0, estimatedRemainingSeconds: null, heartbeatAt: new Date().toISOString() }),
      'utf8',
    );

    let spawned = 0;
    const server = createCatenceHttpServer({
      paths,
      syncSpawnProcess: () => {
        spawned += 1;
        return { unref() {} };
      },
    });
    servers.push(server);
    const origin = await listen(server);

    const status = await fetch(`${origin}/api/v1/sync/status`);
    const payload = await status.json();
    expect(payload.progress.running).toEqual([]);
    expect(payload.progress.recent.map((run: { runId: string }) => run.runId)).not.toContain('done-1');

    // The busy guard passes, so a new sync starts instead of returning 409.
    const started = await fetch(`${origin}/api/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'all' }),
    });
    expect(started.status).toBe(202);
    expect(spawned).toBe(1);

    // Reading the status again swept the orphaned terminal sidecar.
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(path.join(paths.staging, 'garmin'))).filter((file) => file.endsWith('.progress.json'));
    expect(leftovers).toEqual([]);
  });

  it('discovers OpenCode Go models without starting a data sync', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    let discoveryCalls = 0;
    const requestedConfigPaths: string[] = [];
    const server = createCatenceHttpServer({
      paths,
      mergeModels: async (options) => {
        discoveryCalls += 1;
        requestedConfigPaths.push(options.configPath);
        return {
          configPath: options.configPath,
          mergedProfileIds: ['opencode-go'],
          defaultProfile: 'opencode-go',
          counts: { chat: 2, responses: 0, messages: 0 },
          guessedRoutes: [],
        };
      },
      syncSpawnProcess: () => {
        throw new Error('a model refresh must never spawn a sync child');
      },
    });
    servers.push(server);
    const origin = await listen(server);

    const response = await fetch(`${origin}/api/v1/models/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mergedProfileIds: ['opencode-go'],
      counts: { chat: 2, responses: 0, messages: 0 },
    });
    expect(discoveryCalls).toBe(1);
    // Single-store deployments merge into the store's own config.
    expect(requestedConfigPaths[0]).toBe(paths.config);
  });

  it('reads and writes the athlete file through the API', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const server = createCatenceHttpServer({ paths });
    servers.push(server);
    const origin = await listen(server);

    const absent = await fetch(`${origin}/api/v1/athlete-file`);
    expect(absent.status).toBe(200);
    await expect(absent.json()).resolves.toEqual({
      exists: false,
      content: ATHLETE_FILE_TEMPLATE,
      hash: null,
      updatedAt: null,
      revisions: [],
    });

    const created = await fetch(`${origin}/api/v1/athlete-file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Athlete file\n\n## Goals\n\n- Sub-40 10K\n', expectedHash: null }),
    });
    expect(created.status).toBe(200);
    const createdPayload = await created.json();
    expect(createdPayload.exists).toBe(true);
    expect(createdPayload.hash).toEqual(expect.any(String));
    expect(createdPayload.updatedAt).toEqual(expect.any(String));
    expect(createdPayload.content).toBe('# Athlete file\n\n## Goals\n\n- Sub-40 10K\n');

    // If-Match carries the compare-and-swap hash for the append.
    const appended = await fetch(`${origin}/api/v1/athlete-file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': createdPayload.hash },
      body: JSON.stringify({ operation: 'append', content: '## Notes\n\n- Prefers morning sessions' }),
    });
    expect(appended.status).toBe(200);
    const appendedPayload = await appended.json();
    expect(appendedPayload.content).toContain('Prefers morning sessions');
    expect(appendedPayload.hash).not.toBe(createdPayload.hash);

    const reRead = await fetch(`${origin}/api/v1/athlete-file`);
    await expect(reRead.json()).resolves.toMatchObject({
      exists: true,
      hash: appendedPayload.hash,
      revisions: [{ hash: createdPayload.hash.slice(0, 8) }],
    });

    const listed = await (await fetch(`${origin}/api/v1/athlete-file`)).json();
    const revision = await fetch(`${origin}/api/v1/athlete-file?revision=${encodeURIComponent(listed.revisions[0].revisionId)}`);
    expect(revision.status).toBe(200);
    await expect(revision.json()).resolves.toEqual({
      revisionId: listed.revisions[0].revisionId,
      content: '# Athlete file\n\n## Goals\n\n- Sub-40 10K\n',
    });

    const unknownRevision = await fetch(`${origin}/api/v1/athlete-file?revision=123-deadbeef`);
    expect(unknownRevision.status).toBe(404);
    await expect(unknownRevision.json()).resolves.toMatchObject({ error: { code: 'athlete_file_revision_not_found' } });
  });

  it('rejects athlete-file writes without a fresh hash', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const server = createCatenceHttpServer({ paths });
    servers.push(server);
    const origin = await listen(server);

    const missing = await fetch(`${origin}/api/v1/athlete-file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Athlete file\n' }),
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    const created = await fetch(`${origin}/api/v1/athlete-file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Athlete file\n\n## Goals\n\n- Sub-40 10K\n', expectedHash: null }),
    });
    expect(created.status).toBe(200);
    const createdPayload = await created.json();

    const stale = await fetch(`${origin}/api/v1/athlete-file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': 'deadbeef' },
      body: JSON.stringify({ content: '# Athlete file\n\nclobber\n' }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        code: 'athlete_file_conflict',
        currentHash: createdPayload.hash,
        currentContent: createdPayload.content,
      },
    });

    // The conflict left the stored file byte-for-byte untouched.
    const reRead = await fetch(`${origin}/api/v1/athlete-file`);
    await expect(reRead.json()).resolves.toMatchObject({ hash: createdPayload.hash, content: createdPayload.content });
  });
});
