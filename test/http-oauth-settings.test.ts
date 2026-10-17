import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createTcpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatenceHttpServer } from '../src/interfaces/http/server.js';
import {
  addAthlete,
  addMcpKey,
  athleteStorePaths,
  createDemoStore,
  initializeCatalog,
  resolveCatalogPaths,
} from '../src/runtime/index.js';

const ADMIN_TOKEN = 'test-admin-token';
const MARTINA_PASSWORD = 'martina-pass-1';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';
const PUBLIC_HTTPS_URL = 'https://catence.example.com';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function listenOn(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

type Fixture = {
  origin: string;
  settingsFile: string;
  memberToken?: string;
};

/**
 * A catalog with two athletes and two Console accounts (boss = admin, martina
 * = member scoped to alex), served with the legacy admin token, a member key
 * registry, and a Console-managed OAuth settings file. No startup `oauth`
 * option: OAuth starts disabled until the settings file says otherwise.
 */
async function settingsFixture(options: { startupOauth?: boolean; withKeys?: boolean; bare?: boolean } = {}): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), 'catence-http-oauth-settings-'));
  const catalogPaths = resolveCatalogPaths(home);
  await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
  await addAthlete(catalogPaths, { id: 'sam', label: 'Sam' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'alex'), { days: 14, seed: 1, endDate: '2026-08-10' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'sam'), { days: 14, seed: 2, endDate: '2026-08-10' });
  await mkdir(path.join(home, 'console'), { recursive: true });
  await writeFile(path.join(home, 'console', 'accounts.json'), `${JSON.stringify({
    formatVersion: 1,
    accounts: [
      { username: 'boss', passwordHash: bcrypt.hashSync('boss-pass-1', 4), role: 'admin', athletes: 'all', createdAt: '2026-09-28T12:00:00+00:00' },
      { username: 'martina', passwordHash: bcrypt.hashSync(MARTINA_PASSWORD, 4), role: 'member', athletes: ['alex'], createdAt: '2026-09-28T12:00:00+00:00' },
    ],
  }, null, 2)}\n`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const settingsFile = path.join(home, 'oauth', 'settings.json');
  const tokenFile = path.join(home, 'mcp-token');
  await writeFile(tokenFile, ADMIN_TOKEN, 'utf8');
  let memberToken: string | undefined;
  if (options.withKeys) {
    memberToken = (await addMcpKey(path.join(home, 'mcp-keys.json'), { account: 'martina' })).token;
  }
  const server = createCatenceHttpServer({
    catalogPaths,
    // `bare` drops the legacy token and the key registry so the gate arms on
    // effective OAuth alone; the settings file stays configurable.
    ...(options.bare ? {} : { bearerTokenFile: tokenFile, mcpKeysFile: path.join(home, 'mcp-keys.json') }),
    oauthSettingsFile: settingsFile,
    ...(options.startupOauth ? { oauth: { publicUrl: origin } } : {}),
  });
  servers.push(server);
  await listenOn(server, port);
  return { origin, settingsFile, memberToken };
}

/** A schema-valid settings file with a loopback issuer, bypassing the https write rule (dev escape hatch). */
async function writeSettingsFile(settingsFile: string, enabled: boolean, publicUrl: string): Promise<void> {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify({ formatVersion: 1, enabled, publicUrl }, null, 2)}\n`, 'utf8');
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function postForm(url: string, params: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  });
}

function postJson(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? bearer(token) : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function getSettings(origin: string, token: string = ADMIN_TOKEN) {
  return fetch(`${origin}/api/v1/mcp-oauth-settings`, { headers: bearer(token) });
}

async function updateSettings(origin: string, body: unknown, token: string = ADMIN_TOKEN) {
  return postJson(`${origin}/api/v1/mcp-oauth-settings`, body, token);
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

/** register -> authorize -> consent confirm -> code -> token exchange. */
async function runFlow(origin: string, credentials: { username: string; password: string }): Promise<TokenResponse> {
  const registered = await postJson(`${origin}/oauth/register`, {
    client_name: 'OAuth settings test client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const { verifier, challenge } = pkcePair();
  const authorize = await fetch(`${origin}/oauth/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-flow',
    scope: 'mcp:tools',
    resource: `${origin}/mcp`,
  })}`, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const confirm = await postForm(`${origin}/oauth/confirm`, {
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-flow',
    scope: 'mcp:tools',
    resource: `${origin}/mcp`,
    username: credentials.username,
    password: credentials.password,
  });
  expect(confirm.status).toBe(302);
  const code = new URL(confirm.headers.get('location')!).searchParams.get('code')!;
  const exchange = await postForm(`${origin}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: `${origin}/mcp`,
    client_id: client.client_id,
  });
  expect(exchange.status).toBe(200);
  return (await exchange.json()) as TokenResponse;
}

type McpSession = { client: Client; close: () => Promise<void> };

async function mcpSession(origin: string, token: string): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: bearer(token) },
  });
  const client = new Client({ name: 'catence-oauth-settings-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); } };
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
}

describe('Console-managed OAuth settings over HTTP', () => {
  it('reports disabled and answers 404/plain 401 while no settings file exists', async () => {
    const { origin, settingsFile } = await settingsFixture();

    const settings = await getSettings(origin);
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toEqual({
      enabled: false,
      publicUrl: null,
      source: 'disabled',
      settingsFile,
      settingsState: 'missing',
    });

    // No metadata is advertised and the 401 stays plain (bearer-gate shape).
    const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(404);
    const challenged = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBeNull();
  });

  it('reads the startup option as the environment source when no settings file exists', async () => {
    const { origin } = await settingsFixture({ startupOauth: true });

    const settings = await getSettings(origin);
    await expect(settings.json()).resolves.toMatchObject({ enabled: true, publicUrl: origin, source: 'environment', settingsState: 'missing' });

    const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({ issuer: `${origin}/` });
  });

  it('requires an admin principal for the settings routes', async () => {
    const { origin, memberToken } = await settingsFixture({ withKeys: true });

    const anonymous = await fetch(`${origin}/api/v1/mcp-oauth-settings`);
    expect(anonymous.status).toBe(401);

    const memberGet = await getSettings(origin, memberToken!);
    expect(memberGet.status).toBe(403);
    await expect(memberGet.json()).resolves.toMatchObject({ error: { code: 'admin_required' } });

    const memberPost = await updateSettings(origin, { enabled: false }, memberToken!);
    expect(memberPost.status).toBe(403);
    await expect(memberPost.json()).resolves.toMatchObject({ error: { code: 'admin_required' } });
  });

  it('rejects malformed settings writes with 400 and changes nothing', async () => {
    const { origin, settingsFile } = await settingsFixture();
    const malformed: unknown[] = [
      {},
      { enabled: 'yes' },
      { enabled: true },
      { enabled: true, publicUrl: 'http://catence.example.com' },
      { enabled: true, publicUrl: 'https://catence.example.com?utm=1' },
      { enabled: true, publicUrl: 'https://catence.example.com#top' },
      { enabled: false, publicUrl: 5 },
      { enabled: true, publicUrl: 'https://catence.example.com', extra: 1 },
      ['enabled'],
    ];
    for (const body of malformed) {
      const response = await updateSettings(origin, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'mcp_oauth_settings_update_failed' } });
    }
    const notJson = await fetch(`${origin}/api/v1/mcp-oauth-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(ADMIN_TOKEN) },
      body: 'not json',
    });
    expect(notJson.status).toBe(400);
    // Nothing was written: the effective state is still disabled/missing.
    await expect((await (await getSettings(origin)).json()).enabled).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it('enables OAuth at runtime: metadata, RFC 9728 challenge, and mcp-exposure reflect it', async () => {
    const { origin } = await settingsFixture();

    const enabled = await updateSettings(origin, { enabled: true, publicUrl: `${PUBLIC_HTTPS_URL}/` });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      enabled: true,
      publicUrl: PUBLIC_HTTPS_URL,
      source: 'console',
      settingsState: 'ok',
    });

    // The trailing slash was normalized away; the metadata now advertises the issuer.
    const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({ issuer: `${PUBLIC_HTTPS_URL}/` });
    const protectedResource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: `${PUBLIC_HTTPS_URL}/mcp`,
      authorization_servers: [`${PUBLIC_HTTPS_URL}/`],
    });

    // The 401 gains the RFC 9728 challenge, and mcp-exposure reports the effective state.
    const challenged = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC_HTTPS_URL}/.well-known/oauth-protected-resource/mcp"`);
    const exposure = await fetch(`${origin}/api/v1/mcp-exposure`, { headers: bearer(ADMIN_TOKEN) });
    await expect(exposure.json()).resolves.toMatchObject({ oauth: { enabled: true, publicUrl: PUBLIC_HTTPS_URL } });

    // Disabling again is just as immediate: metadata 404s and the challenge disappears.
    const disabled = await updateSettings(origin, { enabled: false, publicUrl: PUBLIC_HTTPS_URL });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({ enabled: false, publicUrl: PUBLIC_HTTPS_URL, source: 'console' });
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const plain = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(plain.status).toBe(401);
    expect(plain.headers.get('www-authenticate')).toBeNull();
  });

  it('runs the full consent flow against a settings-file issuer, scopes the token, and disabling rejects it', { timeout: 90_000 }, async () => {
    const { origin, settingsFile } = await settingsFixture();
    // The write API enforces https for the public issuer; a loopback http
    // issuer is the dev escape hatch the file format allows (same as the
    // startup option), so the flow test seeds the file directly.
    await writeSettingsFile(settingsFile, true, origin);

    const tokens = await runFlow(origin, { username: 'martina', password: MARTINA_PASSWORD });

    // The token is scoped to martina's grants over both the JSON APIs and /mcp.
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    await expect(roster.json()).resolves.toMatchObject({ athletes: [{ id: 'alex', label: 'Alex' }] });
    const forbidden = await fetch(`${origin}/api/v1/dashboard?athleteId=sam`, { headers: bearer(tokens.access_token) });
    expect(forbidden.status).toBe(403);

    const session = await mcpSession(origin, tokens.access_token);
    try {
      const alex = await session.client.callTool({ name: 'catence_status', arguments: { athleteId: 'alex' } });
      expect(alex.isError).toBeFalsy();
      const sam = await session.client.callTool({ name: 'catence_status', arguments: { athleteId: 'sam' } });
      expect(sam.isError).toBe(true);
      expect(payload(sam)).toMatchObject({ data: null, error: { code: 'athlete_forbidden' } });
    } finally {
      await session.close();
    }

    // Disabling OAuth at runtime rejects the token immediately (fail closed),
    // and re-enabling restores it because grants persist in the model store.
    await updateSettings(origin, { enabled: false, publicUrl: PUBLIC_HTTPS_URL });
    const rejected = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    expect(rejected.status).toBe(401);

    await writeSettingsFile(settingsFile, true, origin);
    const restored = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    expect(restored.status).toBe(200);
  });

  it('lets the settings file override the startup option and fails closed on a malformed file', async () => {
    const { origin, settingsFile } = await settingsFixture({ startupOauth: true });

    // Startup-enabled OAuth is overridden to disabled by a valid settings file.
    await writeSettingsFile(settingsFile, false, 'https://unused.example.com');
    const overridden = await getSettings(origin);
    await expect(overridden.json()).resolves.toMatchObject({ enabled: false, publicUrl: 'https://unused.example.com', source: 'console' });
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const plain = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(plain.status).toBe(401);
    expect(plain.headers.get('www-authenticate')).toBeNull();

    // A malformed file fails closed even though the startup option is enabled.
    await writeFile(settingsFile, '{', 'utf8');
    const invalid = await getSettings(origin);
    await expect(invalid.json()).resolves.toMatchObject({ enabled: false, publicUrl: null, source: 'disabled', settingsState: 'invalid' });
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404);

    // A Console write heals the file: OAuth comes back under the Console issuer.
    const healed = await updateSettings(origin, { enabled: true, publicUrl: PUBLIC_HTTPS_URL });
    await expect(healed.json()).resolves.toMatchObject({ enabled: true, source: 'console', settingsState: 'ok' });
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(200);
  });

  it('answers mcp_oauth_not_configured when the server has no settings file', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-http-oauth-bare-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = createCatenceHttpServer({ catalogPaths, bearerToken: ADMIN_TOKEN });
    servers.push(server);
    await listenOn(server, port);

    const get = await getSettings(origin);
    expect(get.status).toBe(400);
    await expect(get.json()).resolves.toMatchObject({ error: { code: 'mcp_oauth_not_configured' } });
    const post = await updateSettings(origin, { enabled: false });
    expect(post.status).toBe(400);
    await expect(post.json()).resolves.toMatchObject({ error: { code: 'mcp_oauth_not_configured' } });
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });

  it('arms the gate on effective OAuth alone — no legacy token, no keys', { timeout: 90_000 }, async () => {
    const { origin, settingsFile } = await settingsFixture({ bare: true });

    // Unarmed loopback: the JSON APIs answer without a token while OAuth is off.
    const open = await fetch(`${origin}/api/v1/athletes`);
    expect(open.status).toBe(200);

    await writeSettingsFile(settingsFile, true, origin);
    const challenged = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);

    // An OAuth token minted through the now-live flow authenticates /mcp.
    const tokens = await runFlow(origin, { username: 'martina', password: MARTINA_PASSWORD });
    const session = await mcpSession(origin, tokens.access_token);
    try {
      const list = await session.client.callTool({ name: 'list_athletes', arguments: {} });
      expect(payload(list)).toMatchObject({ data: { athletes: [{ id: 'alex', label: 'Alex' }] } });
    } finally {
      await session.close();
    }
  });
});
