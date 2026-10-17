import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AccessToken,
  AuthorizationCode,
  ClientIdMetadataDocument,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthServerModel,
  RefreshToken,
} from 'mcp-oauth-server';
import { createFileOAuthServerModel } from '../src/runtime/index.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; model: OAuthServerModel }> {
  const root = await mkdtemp(path.join(tmpdir(), 'catence-oauth-model-'));
  roots.push(root);
  return { root, model: createFileOAuthServerModel(root) };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

function clientRecord(clientId: string = CLIENT_A): OAuthClientInformationFull {
  return {
    client_id: clientId,
    redirect_uris: ['http://127.0.0.1:9/callback'],
    client_name: 'Test client',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

function codeRecord(overrides: Partial<AuthorizationCode> = {}): AuthorizationCode {
  return {
    authorizationCode: `code-${randomUUID()}`,
    clientId: CLIENT_A,
    userId: 'martina',
    expiresAt: new Date(Date.now() + 300_000),
    scopes: ['mcp:tools'],
    resource: 'http://127.0.0.1:8787/mcp',
    codeChallenge: 'challenge',
    redirectUri: 'http://127.0.0.1:9/callback',
    state: 'state-1',
    grantId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

function accessTokenRecord(overrides: Partial<AccessToken> = {}): AccessToken {
  return {
    token: `access-${randomUUID()}`,
    clientId: CLIENT_A,
    userId: 'martina',
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['mcp:tools'],
    resource: 'http://127.0.0.1:8787/mcp',
    grantId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

function refreshTokenRecord(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return {
    token: `refresh-${randomUUID()}`,
    clientId: CLIENT_A,
    userId: 'martina',
    expiresAt: new Date(Date.now() + 14 * 24 * 3_600_000),
    scopes: ['mcp:tools'],
    resource: 'http://127.0.0.1:8787/mcp',
    grantId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

/** Every file under the model root, as { relativePath: contents }. */
async function allFiles(root: string): Promise<Array<{ relative: string; contents: string }>> {
  const files: Array<{ relative: string; contents: string }> = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else files.push({ relative: path.relative(root, entryPath), contents: await readFile(entryPath, 'utf8') });
    }
  }
  await walk(root);
  return files;
}

describe('FileOAuthServerModel clients', () => {
  it('round-trips a registered client and rejects non-UUID ids before any fs use', async () => {
    const { model } = await fixture();
    const client = clientRecord();
    await model.registerClient!(client);
    await expect(model.getClient(CLIENT_A)).resolves.toMatchObject({ client_id: CLIENT_A, client_name: 'Test client' });
    await expect(model.getClient('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();

    // Path-traversal-shaped ids never reach the filesystem.
    for (const hostile of ['../mcp-keys', '..%2f..%2fetc', 'a/b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json']) {
      await expect(model.getClient(hostile)).resolves.toBeUndefined();
    }
    // The lib always passes a full client record (client_id assigned by the
    // server); the interface parameter type is the narrower metadata shape.
    await expect(model.registerClient!({ ...client, client_id: '../evil' } as OAuthClientMetadata)).rejects.toThrow('Invalid OAuth client id');
  });

  it('accepts every field the lib persists, including software_statement', async () => {
    const { model } = await fixture();
    const client = { ...clientRecord(), software_statement: 'eyJhbGciOi...', client_secret: 'secret', client_id_issued_at: 1, client_secret_expires_at: 2 };
    await model.registerClient!(client);
    await expect(model.getClient(CLIENT_A)).resolves.toMatchObject({ software_statement: 'eyJhbGciOi...', client_secret: 'secret' });
  });

  it('fails closed on a malformed client record', async () => {
    const { root, model } = await fixture();
    await mkdir(path.join(root, 'clients'), { recursive: true });
    await writeFile(path.join(root, 'clients', `${CLIENT_A}.json`), '{ not json');
    await expect(model.getClient(CLIENT_A)).resolves.toBeUndefined();
    // The malformed record is swept so it cannot linger.
    await expect(allFiles(root)).resolves.toEqual([]);
  });
});

describe('FileOAuthServerModel authorization codes', () => {
  it('consumes a code exactly once, atomically', async () => {
    const { model } = await fixture();
    const code = codeRecord();
    await model.saveAuthorizationCode!(code, clientRecord());

    const [first, second] = await Promise.all([
      model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A),
      model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A),
    ]);
    const consumed = [first, second].filter((record) => record !== undefined);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      authorizationCode: code.authorizationCode,
      clientId: CLIENT_A,
      userId: 'martina',
      scopes: ['mcp:tools'],
      codeChallenge: 'challenge',
      redirectUri: 'http://127.0.0.1:9/callback',
      state: 'state-1',
      resource: 'http://127.0.0.1:8787/mcp',
      grantId: '33333333-3333-4333-8333-333333333333',
    });
    expect(consumed[0]!.expiresAt).toBeInstanceOf(Date);

    // A later sequential consume is also rejected: the code is single-use.
    await expect(model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A)).resolves.toBeUndefined();
  });

  it('consumes only for the owning client and never burns another client\'s code', async () => {
    const { model } = await fixture();
    const code = codeRecord();
    await model.saveAuthorizationCode!(code, clientRecord());

    // The wrong client consumes nothing...
    await expect(model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_B)).resolves.toBeUndefined();
    // ...so the owning client can still redeem it afterwards.
    await expect(model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A)).resolves.toMatchObject({ clientId: CLIENT_A });
  });

  it('treats an expired code as consumed and sweeps it', async () => {
    const { root, model } = await fixture();
    const code = codeRecord({ expiresAt: new Date(Date.now() - 1_000) });
    await model.saveAuthorizationCode!(code, clientRecord());
    await expect(model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A)).resolves.toBeUndefined();
    await expect(allFiles(path.join(root, 'codes'))).resolves.toEqual([]);
  });

  it('revokes a code outright', async () => {
    const { model } = await fixture();
    const code = codeRecord();
    await model.saveAuthorizationCode!(code, clientRecord());
    await model.revokeAuthorizationCode!(code.authorizationCode);
    await expect(model.consumeAuthorizationCode!(code.authorizationCode, CLIENT_A)).resolves.toBeUndefined();
  });
});

describe('FileOAuthServerModel tokens', () => {
  it('round-trips access and refresh tokens', async () => {
    const { model } = await fixture();
    const access = accessTokenRecord();
    const refresh = refreshTokenRecord();
    await model.saveAccessToken(access, clientRecord());
    await model.saveRefreshToken(refresh, clientRecord());
    await expect(model.getAccessToken(access.token)).resolves.toMatchObject({ token: access.token, clientId: CLIENT_A, userId: 'martina', scopes: ['mcp:tools'] });
    await expect(model.getAccessToken('unknown-token')).resolves.toBeUndefined();
  });

  it('expires access tokens and sweeps the record', async () => {
    const { root, model } = await fixture();
    const access = accessTokenRecord({ expiresAt: new Date(Date.now() - 1_000) });
    await model.saveAccessToken(access, clientRecord());
    await expect(model.getAccessToken(access.token)).resolves.toBeUndefined();
    await expect(allFiles(path.join(root, 'access'))).resolves.toEqual([]);
  });

  it('revokes a token only for the owning client (RFC 7009 ownership)', async () => {
    const { model } = await fixture();
    const access = accessTokenRecord();
    const refresh = refreshTokenRecord();
    await model.saveAccessToken(access, clientRecord());
    await model.saveRefreshToken(refresh, clientRecord());

    // Another client revokes nothing and learns nothing.
    await expect(model.revokeAccessToken(access.token, CLIENT_B)).resolves.toBeUndefined();
    await expect(model.revokeRefreshToken(refresh.token, CLIENT_B)).resolves.toBeUndefined();
    await expect(model.getAccessToken(access.token)).resolves.toMatchObject({ token: access.token });

    // The owning client revokes; the record is gone and never throws.
    await expect(model.revokeAccessToken(access.token, CLIENT_A)).resolves.toMatchObject({ token: access.token, grantId: access.grantId });
    await expect(model.revokeAccessToken(access.token, CLIENT_A)).resolves.toBeUndefined();
    await expect(model.getAccessToken(access.token)).resolves.toBeUndefined();
    await expect(model.revokeRefreshToken(refresh.token, CLIENT_A)).resolves.toMatchObject({ token: refresh.token });
    await expect(model.revokeRefreshToken(refresh.token, CLIENT_A)).resolves.toBeUndefined();
  });

  it('consumes a refresh token exactly once, atomically and client-scoped', async () => {
    const { model } = await fixture();
    const refresh = refreshTokenRecord();
    await model.saveRefreshToken(refresh, clientRecord());

    await expect(model.consumeRefreshToken!(refresh.token, CLIENT_B)).resolves.toBeUndefined();
    const [first, second] = await Promise.all([
      model.consumeRefreshToken!(refresh.token, CLIENT_A),
      model.consumeRefreshToken!(refresh.token, CLIENT_A),
    ]);
    expect([first, second].filter((record) => record !== undefined)).toHaveLength(1);
    expect(first ?? second).toMatchObject({ token: refresh.token, grantId: refresh.grantId });
  });

  it('sweeps every token of one grant and leaves other grants and grant-less tokens alone', async () => {
    const { model } = await fixture();
    const grant = '44444444-4444-4444-8444-444444444444';
    const inGrant = [accessTokenRecord({ grantId: grant }), accessTokenRecord({ grantId: grant }), refreshTokenRecord({ grantId: grant })];
    const outOfGrant = [accessTokenRecord({ grantId: '55555555-5555-4555-8555-555555555555' }), accessTokenRecord({ grantId: undefined })];
    for (const token of [...inGrant, ...outOfGrant]) {
      await model.saveAccessToken(token, clientRecord());
    }
    await model.saveRefreshToken(refreshTokenRecord({ grantId: grant }), clientRecord());

    await model.revokeGrant(grant);

    for (const token of inGrant) {
      await expect(model.getAccessToken(token.token)).resolves.toBeUndefined();
    }
    await expect(model.consumeRefreshToken!(inGrant[2]!.token, CLIENT_A)).resolves.toBeUndefined();
    for (const token of outOfGrant) {
      await expect(model.getAccessToken(token.token)).resolves.toMatchObject({ token: token.token });
    }
    // An empty grant id sweeps nothing.
    await model.revokeGrant('');
    await expect(model.getAccessToken(outOfGrant[0]!.token)).resolves.toMatchObject({ token: outOfGrant[0]!.token });
  });

  it('never stores raw secrets at rest', async () => {
    const { root, model } = await fixture();
    const code = codeRecord();
    const access = accessTokenRecord();
    const refresh = refreshTokenRecord();
    await model.saveAuthorizationCode!(code, clientRecord());
    await model.saveAccessToken(access, clientRecord());
    await model.saveRefreshToken(refresh, clientRecord());

    const files = await allFiles(root);
    expect(files.length).toBeGreaterThan(0);
    const everything = files.map((file) => file.contents).join('\n');
    for (const secret of [code.authorizationCode, access.token, refresh.token]) {
      expect(everything).not.toContain(secret);
    }
    // Records are keyed by the SHA-256 of the secret.
    expect(files.some((file) => file.relative === path.join('access', `${sha256(access.token)}.json`))).toBe(true);
    expect(files.some((file) => file.relative === path.join('refresh', `${sha256(refresh.token)}.json`))).toBe(true);
    expect(files.some((file) => file.relative === path.join('codes', `${sha256(code.authorizationCode)}.json`))).toBe(true);
  });

  it('fails closed on a malformed token record', async () => {
    const { root, model } = await fixture();
    const access = accessTokenRecord();
    await model.saveAccessToken(access, clientRecord());
    await writeFile(path.join(root, 'access', `${sha256(access.token)}.json`), JSON.stringify({ clientId: 42 }));
    await expect(model.getAccessToken(access.token)).resolves.toBeUndefined();
  });
});

describe('FileOAuthServerModel client id metadata documents', () => {
  it('caches a document under the hashed client id and expires it', async () => {
    const { model } = await fixture();
    const clientId = 'https://client.example.com/.well-known/client.json';
    const document: ClientIdMetadataDocument = {
      client: { ...clientRecord(clientId), client_id: clientId },
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    await model.saveClientIdMetadataDocument!(document);
    await expect(model.getClientIdMetadataDocument!(clientId)).resolves.toMatchObject({ expiresAt: expect.any(Date) });
    // The cache key is hashed: the URL never becomes a path component.
    await expect(model.getClientIdMetadataDocument!('../../etc/passwd')).resolves.toBeUndefined();

    const expired: ClientIdMetadataDocument = { client: document.client, expiresAt: new Date(Date.now() - 1_000) };
    await model.saveClientIdMetadataDocument!(expired);
    await expect(model.getClientIdMetadataDocument!(clientId)).resolves.toBeUndefined();
  });
});
