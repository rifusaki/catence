import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  AccessToken,
  AuthorizationCode,
  ClientIdMetadataDocument,
  GrantId,
  OAuthServerModel,
  RefreshToken,
} from 'mcp-oauth-server';
import type { OAuthClientInformationFull } from 'mcp-oauth-server';

/**
 * File-backed OAuthServerModel for the mcp-oauth-server package.
 *
 * Layout under <catalogHome>/oauth/ (directory 0700, files 0600, atomic
 * tmp+rename writes, mirroring mcp-keys.ts):
 *
 *   clients/<clientId>.json          registered client (clientId is a UUID)
 *   codes/<sha256(code)>.json        authorization code (raw code never at rest)
 *   access/<sha256(token)>.json      access token (raw token never at rest)
 *   refresh/<sha256(token)>.json     refresh token (raw token never at rest)
 *   cimd/<sha256(clientIdUrl)>.json  cached client id metadata document
 *
 * Every path component is either a validated UUID or a SHA-256 hex digest, so
 * no record id reaches the filesystem unvalidated. Records are immutable once
 * written; consume operations claim a record with an atomic rename before
 * deleting it, so exactly one concurrent caller wins. Expired records are
 * swept on read; malformed records fail closed (undefined) and are removed.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUID');
const isoTimestampSchema = z.string().datetime();

// The RFC 7591 metadata fields the lib persists on a client. Registered
// clients key them by a UUID client_id; a cached Client ID Metadata Document
// keys them by the document URL instead (see cimdClientRecordSchema).
const clientMetadataFields = {
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  application_type: z.string().optional(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  jwks_uri: z.string().optional(),
  jwks: z.any().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
  // The lib's OAuthClientMetadataSchema passes software_statement through to
  // the stored client; the strict record schema must accept it too.
  software_statement: z.string().optional(),
};

const clientRecordSchema = z.object({
  ...clientMetadataFields,
  client_id: uuidSchema,
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
}).strict();

// A cached CIMD document's client_id is the document URL, not a UUID. The
// record is keyed by the hash of that URL, never by the id itself.
const cimdClientRecordSchema = z.object({
  ...clientMetadataFields,
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
}).strict();

// Codes and tokens are keyed by a hashed secret, never by the client id, and
// can be issued to either kind of client: a DCR-registered client (UUID) or a
// client identified by a Client ID Metadata Document (an HTTPS URL). Both are
// persisted verbatim so the reader must accept both.
const authorizationCodeRecordSchema = z.object({
  clientId: z.string().min(1),
  userId: z.string(),
  expiresAt: isoTimestampSchema,
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  codeChallenge: z.string(),
  redirectUri: z.string(),
  state: z.string().optional(),
  grantId: uuidSchema.optional(),
}).strict();

const tokenRecordSchema = z.object({
  clientId: z.string().min(1),
  userId: z.string().optional(),
  expiresAt: isoTimestampSchema,
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  grantId: uuidSchema.optional(),
}).strict();

const clientIdMetadataDocumentRecordSchema = z.object({
  client: cimdClientRecordSchema,
  expiresAt: isoTimestampSchema,
}).strict();

type ClientRecord = z.infer<typeof clientRecordSchema>;
type AuthorizationCodeRecord = z.infer<typeof authorizationCodeRecordSchema>;
type TokenRecord = z.infer<typeof tokenRecordSchema>;
type ClientIdMetadataDocumentRecord = z.infer<typeof clientIdMetadataDocumentRecordSchema>;

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isExpired(expiresAtIso: string): boolean {
  return new Date(expiresAtIso).getTime() <= Date.now();
}

async function writeRecord(filePath: string, record: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Read one record file. A missing file is undefined; a malformed file fails
 * closed (undefined) and is swept so it cannot linger. Read errors other than
 * ENOENT propagate: the caller's fail-closed wrapper turns them into a
 * rejection, never into an anonymous success.
 */
async function readRecord<Record>(filePath: string, schema: z.ZodType<Record>): Promise<Record | undefined> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return schema.parse(JSON.parse(contents));
  } catch {
    await unlink(filePath).catch(() => {});
    return undefined;
  }
}

async function removeRecord(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export class FileOAuthServerModel implements OAuthServerModel {
  constructor(private readonly root: string) {}

  private clientFile(clientId: string): string {
    return path.join(this.root, 'clients', `${clientId}.json`);
  }

  private codeFile(authorizationCode: string): string {
    return path.join(this.root, 'codes', `${hashSecret(authorizationCode)}.json`);
  }

  private accessTokenFile(accessToken: string): string {
    return path.join(this.root, 'access', `${hashSecret(accessToken)}.json`);
  }

  private refreshTokenFile(refreshToken: string): string {
    return path.join(this.root, 'refresh', `${hashSecret(refreshToken)}.json`);
  }

  private cimdFile(clientId: string): string {
    return path.join(this.root, 'cimd', `${hashSecret(clientId)}.json`);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    // Validate before any filesystem use: client ids become path components.
    if (!UUID_PATTERN.test(clientId)) return undefined;
    const record = await readRecord(this.clientFile(clientId), clientRecordSchema);
    return record as OAuthClientInformationFull | undefined;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (!UUID_PATTERN.test(client.client_id)) throw new Error(`Invalid OAuth client id: ${client.client_id}`);
    await writeRecord(this.clientFile(client.client_id), clientRecordSchema.parse(client));
    return client;
  }

  async saveAuthorizationCode(code: AuthorizationCode, _client: OAuthClientInformationFull): Promise<void> {
    const record: AuthorizationCodeRecord = {
      clientId: code.clientId,
      userId: code.userId,
      expiresAt: code.expiresAt.toISOString(),
      scopes: code.scopes ?? [],
      codeChallenge: code.codeChallenge,
      redirectUri: code.redirectUri,
      ...(code.resource !== undefined ? { resource: code.resource } : {}),
      ...(code.state !== undefined ? { state: code.state } : {}),
      ...(code.grantId !== undefined ? { grantId: code.grantId } : {}),
    };
    await writeRecord(this.codeFile(code.authorizationCode), record);
  }

  /**
   * Read + invalidate in one operation, scoped to the client. The rename is
   * the atomic claim: when several requests present the same code only one
   * rename succeeds, and the losers see ENOENT and return undefined. A request
   * from the wrong client consumes nothing.
   */
  async consumeAuthorizationCode(authorizationCode: string, clientId: string): Promise<AuthorizationCode | undefined> {
    const record = await this.consumeRecord(this.codeFile(authorizationCode), clientId, authorizationCodeRecordSchema);
    if (!record) return undefined;
    return {
      authorizationCode,
      clientId: record.clientId,
      userId: record.userId,
      expiresAt: new Date(record.expiresAt),
      scopes: record.scopes,
      codeChallenge: record.codeChallenge,
      redirectUri: record.redirectUri,
      ...(record.resource !== undefined ? { resource: record.resource } : {}),
      ...(record.state !== undefined ? { state: record.state } : {}),
      ...(record.grantId !== undefined ? { grantId: record.grantId } : {}),
    };
  }

  async revokeAuthorizationCode(authorizationCode: string): Promise<void> {
    await removeRecord(this.codeFile(authorizationCode));
  }

  async saveAccessToken(token: AccessToken, _client: OAuthClientInformationFull): Promise<void> {
    await writeRecord(this.accessTokenFile(token.token), FileOAuthServerModel.tokenRecord(token));
  }

  async getAccessToken(accessToken: string): Promise<AccessToken | undefined> {
    const record = await readRecord(this.accessTokenFile(accessToken), tokenRecordSchema);
    if (!record) return undefined;
    if (isExpired(record.expiresAt)) {
      await removeRecord(this.accessTokenFile(accessToken));
      return undefined;
    }
    return FileOAuthServerModel.accessToken(record, accessToken);
  }

  /**
   * Revoke only when the token was issued to the requesting client; never
   * throw when nothing matches (RFC 7009 §2.2 answers 200 either way).
   */
  async revokeAccessToken(accessToken: string, clientId: string): Promise<AccessToken | undefined> {
    return this.revokeTokenRecord(this.accessTokenFile(accessToken), accessToken, clientId);
  }

  async saveRefreshToken(token: RefreshToken, _client: OAuthClientInformationFull): Promise<void> {
    await writeRecord(this.refreshTokenFile(token.token), FileOAuthServerModel.tokenRecord(token));
  }

  async revokeRefreshToken(refreshToken: string, clientId: string): Promise<RefreshToken | undefined> {
    return this.revokeTokenRecord(this.refreshTokenFile(refreshToken), refreshToken, clientId);
  }

  /** Refresh tokens rotate on every use, so consume is atomic + client-scoped like the code consume. */
  async consumeRefreshToken(refreshToken: string, clientId: string): Promise<RefreshToken | undefined> {
    const record = await this.consumeRecord(this.refreshTokenFile(refreshToken), clientId, tokenRecordSchema);
    if (!record) return undefined;
    return FileOAuthServerModel.refreshToken(record, refreshToken);
  }

  /** Sweep every access and refresh token belonging to one authorization grant. */
  async revokeGrant(grantId: GrantId): Promise<void> {
    if (!grantId) return;
    for (const directory of ['access', 'refresh'] as const) {
      const directoryPath = path.join(this.root, directory);
      let entries: string[];
      try {
        entries = await readdir(directoryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(directoryPath, entry);
        const record = await readRecord(filePath, tokenRecordSchema);
        if (record?.grantId === grantId) await removeRecord(filePath);
      }
    }
  }

  async saveClientIdMetadataDocument(document: ClientIdMetadataDocument): Promise<void> {
    // The cache key is a client-supplied URL: hash it so it never becomes a
    // path component.
    const record: ClientIdMetadataDocumentRecord = {
      client: cimdClientRecordSchema.parse(document.client),
      expiresAt: document.expiresAt.toISOString(),
    };
    await writeRecord(this.cimdFile(document.client.client_id), record);
  }

  async getClientIdMetadataDocument(clientId: string): Promise<ClientIdMetadataDocument | undefined> {
    const record = await readRecord(this.cimdFile(clientId), clientIdMetadataDocumentRecordSchema);
    if (!record) return undefined;
    if (isExpired(record.expiresAt)) {
      await removeRecord(this.cimdFile(clientId));
      return undefined;
    }
    return { client: record.client as OAuthClientInformationFull, expiresAt: new Date(record.expiresAt) };
  }

  private static tokenRecord(token: AccessToken | RefreshToken): TokenRecord {
    return {
      clientId: token.clientId,
      expiresAt: token.expiresAt.toISOString(),
      scopes: token.scopes,
      ...(token.userId !== undefined ? { userId: token.userId } : {}),
      ...(token.resource !== undefined ? { resource: token.resource } : {}),
      ...(token.grantId !== undefined ? { grantId: token.grantId } : {}),
    };
  }

  private static accessToken(record: TokenRecord, token: string): AccessToken {
    return {
      token,
      clientId: record.clientId,
      expiresAt: new Date(record.expiresAt),
      scopes: record.scopes,
      ...(record.userId !== undefined ? { userId: record.userId } : {}),
      ...(record.resource !== undefined ? { resource: record.resource } : {}),
      ...(record.grantId !== undefined ? { grantId: record.grantId } : {}),
    };
  }

  private static refreshToken(record: TokenRecord, token: string): RefreshToken {
    return FileOAuthServerModel.accessToken(record, token);
  }

  private async consumeRecord<Record extends { clientId: string; expiresAt: string }>(
    filePath: string,
    clientId: string,
    schema: z.ZodType<Record>,
  ): Promise<Record | undefined> {
    const record = await readRecord(filePath, schema);
    if (!record) return undefined;
    if (record.clientId !== clientId) return undefined;
    if (isExpired(record.expiresAt)) {
      await removeRecord(filePath);
      return undefined;
    }
    // Claim the record atomically before deleting it: the rename succeeds for
    // exactly one caller even when several requests race the same credential.
    const claimed = `${filePath}.consumed-${randomBytes(6).toString('hex')}`;
    try {
      await rename(filePath, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    await removeRecord(claimed);
    return record;
  }

  private async revokeTokenRecord(filePath: string, token: string, clientId: string): Promise<AccessToken | undefined> {
    const record = await readRecord(filePath, tokenRecordSchema);
    if (!record || record.clientId !== clientId) return undefined;
    await removeRecord(filePath);
    return FileOAuthServerModel.accessToken(record, token);
  }
}

/** The file-backed OAuth server model rooted at <catalogHome>/oauth. */
export function createFileOAuthServerModel(oauthRoot: string): OAuthServerModel {
  return new FileOAuthServerModel(oauthRoot);
}
