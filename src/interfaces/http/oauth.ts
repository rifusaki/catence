import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import {
  authenticateHandler,
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
  OAuthServer,
  redirectUriMatches,
} from 'mcp-oauth-server';
import { createFileOAuthServerModel, resolveCatalogPaths, verifyAccountPassword } from '../../runtime/index.js';

/** What the HTTP gate needs from the lazily built OAuth sub-app. */
export type OAuthAppHandle = {
  /** The Express app; mounted by path delegation for /.well-known/oauth-* and /oauth/*. */
  app: Express;
  /** Verify a bearer access token; null when unknown, expired, or revoked. */
  verifyAccessToken: (token: string) => Promise<{ userId?: string } | null>;
  /** The RFC 9728 metadata URL advertised in the 401 WWW-Authenticate challenge. */
  protectedResourceMetadataUrl: string;
};

/**
 * The OAuth 2.1 authorization server for `catence serve --oauth`, built on the
 * mcp-oauth-server package over the file-backed model in core/runtime/oauth.
 *
 * Layout of the public surface (issuer = publicUrl, resource = publicUrl/mcp):
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 AS metadata
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 PRM metadata
 *   *    /oauth/authorize, /oauth/token, /oauth/register, /oauth/revoke
 *        (mcpAuthRouter mounted at the root with baseUrl = publicUrl + /oauth)
 *   GET  /oauth/consent    login + consent form (round-trips the authorize params)
 *   POST /oauth/confirm    authenticateHandler: bcrypt login, then issues the code
 *   POST /oauth/deny       redirects to the client with error=access_denied
 *
 * The consent round-trip is the lib's contract: the authorize handler 302s to
 * authorizationUrl with the full authorize request as query params, and
 * authenticateHandler re-validates those same params from the confirm POST
 * body — so the consent form echoes them as hidden fields next to the
 * username/password inputs. Credentials and tokens are never logged.
 */

export async function createOAuthApp(options: { catalogRoot: string; publicUrl: string }): Promise<OAuthAppHandle> {
  const publicUrl = options.publicUrl.replace(/\/+$/, '');
  const issuerUrl = new URL(publicUrl);
  const resourceServerUrl = new URL(`${publicUrl}/mcp`);
  const oauthBaseUrl = new URL(`${publicUrl}/oauth`);
  const accountPaths = resolveCatalogPaths(options.catalogRoot);
  const provider = new OAuthServer({
    issuerUrl,
    authorizationUrl: new URL(`${publicUrl}/oauth/consent`),
    resourceServerUrl,
    scopesSupported: ['mcp:tools'],
    clientIdMetadataDocuments: true,
    model: createFileOAuthServerModel(path.join(options.catalogRoot, 'oauth')),
  });
  const oauthMetadata = createOAuthMetadata({ provider, baseUrl: oauthBaseUrl });
  const protectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
  };
  const protectedResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  // Behind the tunnel the peer is the tunnel itself, so X-Forwarded-For is
  // always set; express-rate-limit v8 refuses to run with it while
  // `trust proxy` is false. Key the limiters on the socket address instead.
  const rateLimitValidate = { xForwardedForHeader: false, forwardedHeader: false } as const;

  const app = express();
  app.disable('x-powered-by');

  // The issuer carries no path, so the canonical RFC 8414/RFC 9728 locations
  // are the bare well-known paths; the lib's router serves the same documents
  // at the /oauth-suffixed variants. These routes shadow nothing the lib needs.
  const serveMetadata = (document: unknown) => (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json(document);
  };
  app.get('/.well-known/oauth-authorization-server', serveMetadata(oauthMetadata));
  app.get('/.well-known/oauth-protected-resource', serveMetadata(protectedResourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', serveMetadata(protectedResourceMetadata));

  app.use(mcpAuthRouter({
    provider,
    baseUrl: oauthBaseUrl,
    resourceServerUrl,
    authorizationOptions: { rateLimit: { validate: rateLimitValidate } },
    tokenOptions: { rateLimit: { validate: rateLimitValidate } },
    clientRegistrationOptions: { rateLimit: { validate: rateLimitValidate } },
    revocationOptions: { rateLimit: { validate: rateLimitValidate } },
  }));

  app.get('/oauth/consent', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const clientId = typeof request.query.client_id === 'string' ? request.query.client_id : '';
    const client = clientId ? await provider.getClient(clientId).catch(() => undefined) : undefined;
    if (!client) {
      response.status(400).json({ error: 'invalid_request', error_description: 'Unknown client_id.' });
      return;
    }
    response.status(200).type('html').send(renderConsentPage(request.query, client.client_name ?? client.client_id));
  });

  // authenticateHandler returns an Express Router: it must be mounted with
  // app.use so the mount path is stripped before the router matches its
  // internal POST / route (app.post(path, router) leaves req.url intact and
  // the router 404s).
  app.use('/oauth/confirm', authenticateHandler({
    provider,
    rateLimit: { windowMs: 15 * 60 * 1000, max: 20, validate: rateLimitValidate },
    getUser: async (request) => {
      const username = typeof request.body?.username === 'string' ? request.body.username : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      if (!username || !password) return null;
      const valid = await verifyAccountPassword(accountPaths, username, password);
      return valid ? username : null;
    },
  }));

  app.post('/oauth/deny', express.urlencoded({ extended: false }), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    const state = typeof body.state === 'string' ? body.state : undefined;
    const client = clientId ? await provider.getClient(clientId).catch(() => undefined) : undefined;
    const redirectRegistered = client !== undefined && redirectUri !== '' && client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered));
    if (!client || !redirectRegistered) {
      response.status(400).json({ error: 'invalid_request', error_description: 'Unknown client_id or unregistered redirect_uri.' });
      return;
    }
    const target = new URL(redirectUri);
    target.searchParams.set('error', 'access_denied');
    if (state) target.searchParams.set('state', state);
    target.searchParams.set('iss', issuerUrl.href);
    response.redirect(302, target.toString());
  });

  const verifyAccessToken = async (token: string): Promise<{ userId?: string } | null> => {
    try {
      const authInfo = await provider.verifyAccessToken(token);
      return { userId: authInfo.userId };
    } catch {
      // Unknown, expired, or revoked tokens all fail closed to null.
      return null;
    }
  };

  return { app, verifyAccessToken, protectedResourceMetadataUrl };
}

/** The authorize request parameters the consent form must echo back. */
const CONSENT_PARAMETERS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConsentPage(query: Request['query'], clientName: string): string {
  const hiddenInputs = CONSENT_PARAMETERS
    .filter((name) => typeof query[name] === 'string' && query[name] !== '')
    .map((name) => `      <input type="hidden" name="${name}" value="${escapeHtml(query[name] as string)}">`)
    .join('\n');
  const redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : '';
  let redirectHost = redirectUri;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    // Display the raw value when it does not parse; the confirm step rejects it.
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Catence — authorize ${escapeHtml(clientName)}</title>
  </head>
  <body>
    <h1>Authorize ${escapeHtml(clientName)}</h1>
    <p><strong>${escapeHtml(clientName)}</strong> is asking to access your Catence data${redirectHost ? ` (redirecting to ${escapeHtml(redirectHost)})` : ''}.</p>
    <form method="post">
${hiddenInputs}
      <p><label>Username <input type="text" name="username" autocomplete="username" required></label></p>
      <p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p>
      <p>
        <button type="submit" formaction="/oauth/confirm">Approve</button>
        <button type="submit" formaction="/oauth/deny">Deny</button>
      </p>
    </form>
  </body>
</html>
`;
}
