/**
 * Public-client normalization for OAuth client metadata.
 *
 * Some OAuth clients — OpenAI's ChatGPT/Codex connector is the known case —
 * register (RFC 7591 DCR) or publish a client ID metadata document (CIMD)
 * with `token_endpoint_auth_method: "private_key_jwt"`. Catence has no JWKS
 * trust for client assertions, so it cannot honor that method; mcp-oauth-server
 * rejects any method other than "none"/"client_secret_post" outright, which
 * breaks those clients at registration or authorization time with
 * `invalid_client: Unsupported token_endpoint_auth_method`.
 *
 * The fix is to treat such clients as what they are: public clients. No client
 * secret is issued, redirect URIs are validated exactly as before, and PKCE
 * with S256 stays enforced at the authorization and token endpoints — the same
 * protection a public client gets with `"none"`. A `client_assertion` the
 * client later sends at the token endpoint is ignored by the server's
 * client-authentication step, which only reads `client_id`/`client_secret`.
 */

export const PRIVATE_KEY_JWT = 'private_key_jwt';

type ClientMetadataLike = { token_endpoint_auth_method?: unknown } & Record<string, unknown>;

/**
 * True when the metadata declares private_key_jwt client authentication.
 */
export function declaresPrivateKeyJwt(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as ClientMetadataLike).token_endpoint_auth_method === PRIVATE_KEY_JWT;
}

/**
 * Return the metadata with private_key_jwt downgraded to "none" (public
 * client). Anything else passes through unchanged.
 */
export function asPublicClientMetadata<T>(value: T): T {
  if (!declaresPrivateKeyJwt(value)) return value;
  return { ...(value as ClientMetadataLike), token_endpoint_auth_method: 'none' } as T;
}
