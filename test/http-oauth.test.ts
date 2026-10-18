import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createTcpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatenceHttpServer } from '../src/interfaces/http/server.js';
import {
  addAthlete,
  athleteStorePaths,
  createDemoStore,
  initializeCatalog,
  resolveCatalogPaths,
} from '../src/runtime/index.js';

const MARTINA_PASSWORD = 'martina-pass-1';
const BOSS_PASSWORD = 'boss-pass-1';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';

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
  publicUrl: string;
  home: string;
};

async function oauthFixture(): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), 'catence-http-oauth-'));
  const catalogPaths = resolveCatalogPaths(home);
  await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
  await addAthlete(catalogPaths, { id: 'sam', label: 'Sam' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'alex'), { days: 14, seed: 1, endDate: '2026-08-10' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'sam'), { days: 14, seed: 2, endDate: '2026-08-10' });
  await mkdir(path.join(home, 'console'), { recursive: true });
  await writeFile(path.join(home, 'console', 'accounts.json'), `${JSON.stringify({
    formatVersion: 1,
    accounts: [
      { username: 'boss', passwordHash: bcrypt.hashSync(BOSS_PASSWORD, 4), role: 'admin', athletes: 'all', createdAt: '2026-09-28T12:00:00+00:00' },
      { username: 'martina', passwordHash: bcrypt.hashSync(MARTINA_PASSWORD, 4), role: 'member', athletes: ['alex'], createdAt: '2026-09-28T12:00:00+00:00' },
    ],
  }, null, 2)}\n`);
  // The issuer is the public URL: the fixture grabs a free port first so the
  // server can be created with its own address (https is CLI-level validation;
  // the lib allows http loopback issuers for development).
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const server = createCatenceHttpServer({ catalogPaths, oauth: { publicUrl } });
  servers.push(server);
  await listenOn(server, port);
  return { origin: publicUrl, publicUrl, home };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function postForm(url: string, params: Record<string, string>, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? bearer(token) : {}) },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  });
}

function postJson(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    // The /mcp transport requires both accept types; JSON endpoints ignore it.
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? bearer(token) : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

type AuthorizeParams = {
  clientId: string;
  redirectUri?: string;
  challenge?: string;
  challengeMethod?: string;
  state?: string;
  scope?: string;
  resource?: string;
  omitChallenge?: boolean;
};

function authorizeUrl(origin: string, params: AuthorizeParams): URL {
  const url = new URL(`${origin}/oauth/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri ?? REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  if (!params.omitChallenge) {
    url.searchParams.set('code_challenge', params.challenge ?? pkcePair().challenge);
    url.searchParams.set('code_challenge_method', params.challengeMethod ?? 'S256');
  }
  if (params.state) url.searchParams.set('state', params.state);
  if (params.scope) url.searchParams.set('scope', params.scope);
  if (params.resource) url.searchParams.set('resource', params.resource);
  return url;
}

type RegisteredClient = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types?: string[];
};

async function registerClient(origin: string, overrides: Record<string, unknown> = {}): Promise<RegisteredClient> {
  const response = await postJson(`${origin}/oauth/register`, {
    client_name: 'OAuth test client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as RegisteredClient;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

async function exchangeCode(origin: string, client: RegisteredClient, code: string, verifier: string, resource: string, redirectUri: string = REDIRECT_URI): Promise<Response> {
  return postForm(`${origin}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource,
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  });
}

/** register -> authorize -> consent confirm -> code -> token exchange. */
async function runFlow(origin: string, publicUrl: string, credentials: { username: string; password: string }, registerOverrides: Record<string, unknown> = {}): Promise<{ client: RegisteredClient; tokens: TokenResponse; verifier: string; code: string }> {
  const client = await registerClient(origin, registerOverrides);
  const { verifier, challenge } = pkcePair();
  const authorize = await fetch(authorizeUrl(origin, {
    clientId: client.client_id,
    challenge,
    state: 'st-flow',
    scope: 'mcp:tools',
    resource: `${publicUrl}/mcp`,
  }), { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const consentUrl = new URL(authorize.headers.get('location')!);

  const confirm = await postForm(`${origin}/oauth/confirm`, {
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-flow',
    scope: 'mcp:tools',
    resource: `${publicUrl}/mcp`,
    username: credentials.username,
    password: credentials.password,
  });
  expect(confirm.status).toBe(302);
  const callback = new URL(confirm.headers.get('location')!);
  const code = callback.searchParams.get('code')!;
  expect(code).toBeTruthy();
  expect(callback.searchParams.get('state')).toBe('st-flow');
  expect(callback.searchParams.get('iss')).toBe(`${new URL(publicUrl).href}`);
  expect(consentUrl.pathname).toBe('/oauth/consent');

  const exchange = await exchangeCode(origin, client, code, verifier, `${publicUrl}/mcp`);
  expect(exchange.status).toBe(200);
  const tokens = (await exchange.json()) as TokenResponse;
  expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'mcp:tools' });
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return { client, tokens, verifier, code };
}

type McpSession = { client: Client; close: () => Promise<void> };

async function mcpSession(origin: string, token: string): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: bearer(token) },
  });
  const client = new Client({ name: 'catence-oauth-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); } };
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
}

describe('OAuth 2.1 authorization server over HTTP', () => {
  it('serves the RFC 9728 protected-resource and RFC 8414 authorization-server metadata', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const issuer = new URL(publicUrl).href; // URL normalization adds the trailing slash

    for (const metadataPath of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await fetch(`${origin}${metadataPath}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      await expect(response.json()).resolves.toEqual({
        resource: `${publicUrl}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ['mcp:tools'],
        bearer_methods_supported: ['header'],
      });
    }

    const asResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(asResponse.status).toBe(200);
    const metadata = (await asResponse.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      revocation_endpoint: `${publicUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: ['mcp:tools'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('challenges 401 with resource_metadata only when oauth is enabled; a non-oauth server answers a plain 401 and works', async () => {
    const { origin, publicUrl, home } = await oauthFixture();

    // OAuth enabled: the 401 points MCP clients at the PRM document (RFC 9728).
    const challenged = await fetch(`${origin}/api/v1/athletes`);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    const challengedMcp = await postJson(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(challengedMcp.status).toBe(401);
    expect(challengedMcp.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    // Health probes stay open.
    expect((await fetch(`${origin}/health`)).status).toBe(200);

    // Without oauth the gate is a plain bearer gate: no challenge header, and
    // the server is fully functional (the stdio/non-oauth path never loads
    // express — the OAuth sub-app is only built when options.oauth is set).
    const catalogPaths = resolveCatalogPaths(home);
    const plain = createCatenceHttpServer({ catalogPaths, bearerToken: 'static-secret' });
    servers.push(plain);
    await listenOn(plain, await freePort());
    const plainOrigin = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    const denied = await fetch(`${plainOrigin}/api/v1/athletes`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBeNull();
    // The OAuth routes do not exist without --oauth.
    expect((await fetch(`${plainOrigin}/.well-known/oauth-authorization-server`, { headers: bearer('static-secret') })).status).toBe(404);
    // An authenticated request works end to end.
    const roster = await fetch(`${plainOrigin}/api/v1/athletes`, { headers: bearer('static-secret') });
    expect(roster.status).toBe(200);
    const initialize = await postJson(`${plainOrigin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'plain', version: '0.1.0' } } }, 'static-secret');
    expect(initialize.status).toBe(200);
  });

  it('registers clients over DCR and rejects invalid registrations', async () => {
    const { origin } = await oauthFixture();

    // Public client: no secret is issued.
    const publicClient = await registerClient(origin);
    expect(publicClient.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(publicClient.client_secret).toBeUndefined();
    expect(publicClient.redirect_uris).toEqual([REDIRECT_URI]);

    // Confidential client (default auth method): a secret is issued.
    const confidential = await registerClient(origin, { token_endpoint_auth_method: undefined });
    expect(confidential.client_secret).toBeTruthy();

    // Non-loopback http redirect URIs are rejected (RFC 8252 transport security).
    const insecure = await postJson(`${origin}/oauth/register`, { redirect_uris: ['http://example.com/callback'] });
    expect(insecure.status).toBe(400);
    await expect(insecure.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' });

    // Auth methods outside client_secret_post/none are rejected at registration.
    const basic = await postJson(`${origin}/oauth/register`, { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'client_secret_basic' });
    expect(basic.status).toBe(400);
    await expect(basic.json()).resolves.toMatchObject({ error: 'unsupported_token_endpoint_auth_method' });

    // Grant types the server does not offer are rejected.
    const badGrant = await postJson(`${origin}/oauth/register`, { redirect_uris: [REDIRECT_URI], grant_types: ['password'] });
    expect(badGrant.status).toBe(400);
    await expect(badGrant.json()).resolves.toMatchObject({ error: 'unsupported_grant_type' });

    // The authorization_code grant requires at least one redirect URI.
    const noRedirect = await postJson(`${origin}/oauth/register`, { redirect_uris: [], grant_types: ['authorization_code'] });
    expect(noRedirect.status).toBe(400);
    await expect(noRedirect.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('treats private_key_jwt registrations as public clients and runs their full flow', { timeout: 90_000 }, async () => {
    const { origin, publicUrl } = await oauthFixture();

    // OpenAI's connector registers (and publishes its CIMD document) with
    // token_endpoint_auth_method private_key_jwt. Catence cannot verify a
    // client JWT assertion, so the registration is downgraded to a public
    // client: no secret is issued and the stored method reads "none", while
    // PKCE S256 still protects authorize and token. The same downgrade
    // applies to the CIMD path (unit-tested in oauth-public-client.test.ts).
    const client = await registerClient(origin, { token_endpoint_auth_method: 'private_key_jwt' });
    expect(client.client_secret).toBeUndefined();
    expect((client as Record<string, unknown>).token_endpoint_auth_method).toBe('none');

    // The downgraded client completes the full authorization-code flow and
    // its token drives the JSON APIs and /mcp within the account scope.
    const { tokens } = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD }, { token_endpoint_auth_method: 'private_key_jwt' });
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({ defaultAthleteId: 'alex', athletes: [{ id: 'alex', label: 'Alex' }] });
    const forbidden = await fetch(`${origin}/api/v1/dashboard?athleteId=sam`, { headers: bearer(tokens.access_token) });
    expect(forbidden.status).toBe(403);
    const initialize = await postJson(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pkj', version: '0.1.0' } } }, tokens.access_token);
    expect(initialize.status).toBe(200);
  });

  it('runs the full flow — register, authorize, consent login, code, token — and enforces the account scope at the gate', { timeout: 90_000 }, async () => {
    const { origin, publicUrl } = await oauthFixture();
    const { tokens } = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD });

    // The access token authenticates the JSON APIs, scoped to martina's grants.
    const roster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    expect(roster.status).toBe(200);
    await expect(roster.json()).resolves.toMatchObject({ defaultAthleteId: 'alex', athletes: [{ id: 'alex', label: 'Alex' }] });
    const forbidden = await fetch(`${origin}/api/v1/dashboard?athleteId=sam`, { headers: bearer(tokens.access_token) });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: { code: 'athlete_forbidden' } });

    // The same token drives scoped MCP tool calls over /mcp.
    const session = await mcpSession(origin, tokens.access_token);
    try {
      const list = await session.client.callTool({ name: 'list_athletes', arguments: {} });
      expect(payload(list)).toMatchObject({ data: { defaultAthleteId: 'alex', athletes: [{ id: 'alex', label: 'Alex' }] } });

      const alex = await session.client.callTool({ name: 'catence_status', arguments: { athleteId: 'alex' } });
      expect(alex.isError).toBeFalsy();
      expect(payload(alex)).toMatchObject({ athlete: { id: 'alex', label: 'Alex' } });

      const sam = await session.client.callTool({ name: 'catence_status', arguments: { athleteId: 'sam' } });
      expect(sam.isError).toBe(true);
      expect(payload(sam)).toMatchObject({ data: null, error: { code: 'athlete_forbidden' } });
    } finally {
      await session.close();
    }

    // An admin account's token sees the whole roster.
    const adminFlow = await runFlow(origin, publicUrl, { username: 'boss', password: BOSS_PASSWORD });
    const adminRoster = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(adminFlow.tokens.access_token) });
    await expect(adminRoster.json()).resolves.toMatchObject({
      athletes: [{ id: 'alex' }, { id: 'sam' }],
    });
  });

  it('renders the consent page with the authorize params round-tripped as hidden fields', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const client = await registerClient(origin);
    const { challenge } = pkcePair();
    const authorize = await fetch(authorizeUrl(origin, {
      clientId: client.client_id,
      challenge,
      state: 'st-consent',
      scope: 'mcp:tools',
      resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(authorize.status).toBe(302);

    // The lib's authorize handler 302s to the consent URL carrying the full
    // authorize request as query parameters.
    const consentUrl = new URL(authorize.headers.get('location')!);
    expect(consentUrl.pathname).toBe('/oauth/consent');
    expect(consentUrl.searchParams.get('client_id')).toBe(client.client_id);
    expect(consentUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(consentUrl.searchParams.get('response_type')).toBe('code');
    expect(consentUrl.searchParams.get('code_challenge')).toBe(challenge);
    expect(consentUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consentUrl.searchParams.get('state')).toBe('st-consent');
    expect(consentUrl.searchParams.get('scope')).toBe('mcp:tools');
    expect(consentUrl.searchParams.get('resource')).toBe(`${publicUrl}/mcp`);

    const page = await fetch(consentUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain('formaction="/oauth/confirm"');
    expect(html).toContain('formaction="/oauth/deny"');
    // The hidden fields echo the authorize params back to the confirm POST.
    for (const name of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain(`value="${challenge}"`);
    expect(html).toContain('OAuth test client');
  });

  it('rotates refresh tokens, rejects reuse, and revokes the whole grant', { timeout: 90_000 }, async () => {
    const { origin, publicUrl } = await oauthFixture();
    const { client, tokens } = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD });

    // Rotation issues a new pair; the old refresh token is dead.
    const rotated = await postForm(`${origin}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      resource: `${publicUrl}/mcp`,
      client_id: client.client_id,
    });
    expect(rotated.status).toBe(200);
    const rotatedTokens = (await rotated.json()) as TokenResponse;
    expect(rotatedTokens.access_token).not.toBe(tokens.access_token);
    expect(rotatedTokens.refresh_token).not.toBe(tokens.refresh_token);

    const reuse = await postForm(`${origin}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      resource: `${publicUrl}/mcp`,
      client_id: client.client_id,
    });
    expect(reuse.status).toBe(400);
    await expect(reuse.json()).resolves.toMatchObject({ error: 'invalid_grant' });

    // The rotated access token works at the gate.
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(rotatedTokens.access_token) })).status).toBe(200);

    // Revoking the refresh token sweeps the whole grant: refresh and access
    // tokens of that authorization all fail closed.
    const revoke = await postForm(`${origin}/oauth/revoke`, { token: rotatedTokens.refresh_token, client_id: client.client_id });
    expect(revoke.status).toBe(200);
    const refreshAfterRevoke = await postForm(`${origin}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: rotatedTokens.refresh_token,
      resource: `${publicUrl}/mcp`,
      client_id: client.client_id,
    });
    expect(refreshAfterRevoke.status).toBe(400);
    await expect(refreshAfterRevoke.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(rotatedTokens.access_token) })).status).toBe(401);
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) })).status).toBe(401);
  });

  it('rejects a wrong consent password without issuing a code', async () => {
    const { origin, publicUrl, home } = await oauthFixture();
    const client = await registerClient(origin);
    const { challenge } = pkcePair();
    const authorize = await fetch(authorizeUrl(origin, {
      clientId: client.client_id,
      challenge,
      state: 'st-wrong',
      resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(authorize.status).toBe(302);

    // The lib's authenticateHandler maps a failed getUser to an auth error:
    // a direct error response, never a redirect carrying a code.
    const confirm = await postForm(`${origin}/oauth/confirm`, {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-wrong',
      resource: `${publicUrl}/mcp`,
      username: 'martina',
      password: 'not-the-password',
    });
    expect(confirm.headers.get('location')).toBeNull();
    expect(confirm.status).toBe(500);
    await expect(confirm.json()).resolves.toMatchObject({ error: 'server_error' });

    // No authorization code was persisted for the failed login.
    const { readdir } = await import('node:fs/promises');
    const codes = await readdir(path.join(home, 'oauth', 'codes')).catch(() => [] as string[]);
    expect(codes).toEqual([]);
  });

  it('rejects authorize requests with plain or missing PKCE, unknown clients, and unregistered redirect URIs', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const client = await registerClient(origin);
    const { challenge } = pkcePair();

    // Missing code_challenge: a post-redirect error (invalid_request). A
    // request-params schema failure happens before the lib extracts state, so
    // the error redirect carries no state parameter.
    const missing = await fetch(authorizeUrl(origin, {
      clientId: client.client_id, omitChallenge: true, state: 'st-1', resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(missing.status).toBe(302);
    const missingTarget = new URL(missing.headers.get('location')!);
    expect(missingTarget.searchParams.get('error')).toBe('invalid_request');
    expect(missingTarget.searchParams.get('state')).toBeNull();

    // code_challenge_method=plain is rejected (S256 only).
    const plain = await fetch(authorizeUrl(origin, {
      clientId: client.client_id, challenge, challengeMethod: 'plain', state: 'st-2', resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    // Unknown client_id: a direct 400, never a redirect.
    const unknown = await fetch(authorizeUrl(origin, {
      clientId: randomUUID(), challenge, resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ error: 'invalid_client' });

    // Unregistered redirect_uri: a direct 400 (the redirect target is untrusted).
    const unregistered = await fetch(authorizeUrl(origin, {
      clientId: client.client_id, challenge, redirectUri: 'http://127.0.0.1:9/other', resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    expect(unregistered.status).toBe(400);
    await expect(unregistered.json()).resolves.toMatchObject({ error: 'invalid_request' });

    // A resource outside this server: a post-redirect invalid_target error.
    const wrongResource = await fetch(authorizeUrl(origin, {
      clientId: client.client_id, challenge, state: 'st-3', resource: `${publicUrl}/elsewhere`,
    }), { redirect: 'manual' });
    expect(wrongResource.status).toBe(302);
    const wrongResourceTarget = new URL(wrongResource.headers.get('location')!);
    expect(wrongResourceTarget.searchParams.get('error')).toBe('invalid_target');
    expect(wrongResourceTarget.searchParams.get('state')).toBe('st-3');
  });

  it('rejects a wrong PKCE verifier and code reuse at the token endpoint', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const client = await registerClient(origin);
    const { verifier, challenge } = pkcePair();
    const authorize = await fetch(authorizeUrl(origin, {
      clientId: client.client_id, challenge, state: 'st-code', scope: 'mcp:tools', resource: `${publicUrl}/mcp`,
    }), { redirect: 'manual' });
    const confirm = await postForm(`${origin}/oauth/confirm`, {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-code',
      scope: 'mcp:tools',
      resource: `${publicUrl}/mcp`,
      username: 'martina',
      password: MARTINA_PASSWORD,
    });
    expect(confirm.status).toBe(302);
    const code = new URL(confirm.headers.get('location')!).searchParams.get('code')!;

    // A wrong verifier fails, and the code is burned: even the right verifier
    // cannot redeem it afterwards (no brute-force retries).
    const wrongVerifier = await exchangeCode(origin, client, code, pkcePair().verifier, `${publicUrl}/mcp`);
    expect(wrongVerifier.status).toBe(400);
    await expect(wrongVerifier.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    const rightVerifier = await exchangeCode(origin, client, code, verifier, `${publicUrl}/mcp`);
    expect(rightVerifier.status).toBe(400);
    await expect(rightVerifier.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects code reuse at the token endpoint', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const { client, tokens, verifier, code } = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD });
    expect(tokens.access_token).toBeTruthy();

    const reuse = await exchangeCode(origin, client, code, verifier, `${publicUrl}/mcp`);
    expect(reuse.status).toBe(400);
    await expect(reuse.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a token exchange with the wrong resource indicator', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const client = await registerClient(origin);

    // Each case gets its own code: the lib burns a code on any failed
    // exchange, so a code rejected for its resource cannot be retried.
    const obtainCode = async (): Promise<{ code: string; verifier: string }> => {
      const { verifier, challenge } = pkcePair();
      await fetch(authorizeUrl(origin, {
        clientId: client.client_id, challenge, scope: 'mcp:tools', resource: `${publicUrl}/mcp`,
      }), { redirect: 'manual' });
      const confirm = await postForm(`${origin}/oauth/confirm`, {
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:tools',
        resource: `${publicUrl}/mcp`,
        username: 'martina',
        password: MARTINA_PASSWORD,
      });
      expect(confirm.status).toBe(302);
      return { code: new URL(confirm.headers.get('location')!).searchParams.get('code')!, verifier };
    };

    // A resource indicator that does not match the code's resource.
    const wrong = await obtainCode();
    const wrongResource = await exchangeCode(origin, client, wrong.code, wrong.verifier, `${publicUrl}/elsewhere`);
    expect(wrongResource.status).toBe(400);
    await expect(wrongResource.json()).resolves.toMatchObject({ error: 'invalid_target' });

    // strictResource: a missing resource indicator is rejected too.
    const missing = await obtainCode();
    const missingResource = await postForm(`${origin}/oauth/token`, {
      grant_type: 'authorization_code',
      code: missing.code,
      code_verifier: missing.verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
    });
    expect(missingResource.status).toBe(400);
    await expect(missingResource.json()).resolves.toMatchObject({ error: 'invalid_target' });
  });

  it('fails closed for tampered, expired, and orphaned-account tokens', { timeout: 90_000 }, async () => {
    const { origin, publicUrl, home } = await oauthFixture();
    const { tokens } = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD });

    // A tampered token is unknown to the model. A presented-but-rejected
    // token gets RFC 6750 invalid_token with no resource_metadata: the
    // client already holds a credential, so steering it into OAuth
    // discovery would be wrong (and flips static-key MCP connectors, which
    // probe with a key, into the OAuth flow).
    const tampered = `${tokens.access_token.slice(0, -1)}${tokens.access_token.endsWith('a') ? 'b' : 'a'}`;
    const tamperedResponse = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tampered) });
    expect(tamperedResponse.status).toBe(401);
    expect(tamperedResponse.headers.get('www-authenticate')).toBe('Bearer error="invalid_token", error_description="The access token is invalid or expired."');
    const tamperedMcp = await postJson(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, tampered);
    expect(tamperedMcp.status).toBe(401);
    expect(tamperedMcp.headers.get('www-authenticate')).toBe('Bearer error="invalid_token", error_description="The access token is invalid or expired."');

    // An expired token is swept and rejected: rewrite the record's expiry.
    const recordPath = path.join(home, 'oauth', 'access', `${sha256(tokens.access_token)}.json`);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { expiresAt: string };
    record.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(recordPath, JSON.stringify(record));
    const expiredResponse = await fetch(`${origin}/api/v1/athletes`, { headers: bearer(tokens.access_token) });
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.headers.get('www-authenticate')).toBe('Bearer error="invalid_token", error_description="The access token is invalid or expired."');

    // A deleted account fails closed: the token verifies, the principal does not.
    const second = await runFlow(origin, publicUrl, { username: 'martina', password: MARTINA_PASSWORD });
    await writeFile(path.join(home, 'console', 'accounts.json'), `${JSON.stringify({
      formatVersion: 1,
      accounts: [
        { username: 'boss', passwordHash: bcrypt.hashSync(BOSS_PASSWORD, 4), role: 'admin', athletes: 'all', createdAt: '2026-09-28T12:00:00+00:00' },
      ],
    })}\n`);
    expect((await fetch(`${origin}/api/v1/athletes`, { headers: bearer(second.tokens.access_token) })).status).toBe(401);
    expect((await postJson(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, second.tokens.access_token)).status).toBe(401);
  });

  it('redirects to the client with error=access_denied when consent is denied', async () => {
    const { origin, publicUrl } = await oauthFixture();
    const client = await registerClient(origin);
    const deny = await postForm(`${origin}/oauth/deny`, {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      state: 'st-deny',
    });
    expect(deny.status).toBe(302);
    const target = new URL(deny.headers.get('location')!);
    expect(target.origin).toBe('http://127.0.0.1:9');
    expect(target.pathname).toBe('/callback');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('st-deny');
    expect(target.searchParams.get('iss')).toBe(new URL(publicUrl).href);

    // Denying with an unregistered redirect URI is a direct 400.
    const badDeny = await postForm(`${origin}/oauth/deny`, {
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:9/other',
    });
    expect(badDeny.status).toBe(400);
  });
});
