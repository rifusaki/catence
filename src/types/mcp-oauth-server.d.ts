/**
 * Type surface for mcp-oauth-server@1.0.1 (mapped via tsconfig `paths`).
 *
 * The package's dist/index.d.ts re-exports several modules through
 * extensionless relative paths (`from './OAuthServer'`, `from './types'`, ...)
 * and dist/OAuthServer.d.ts does the same for `./types`, `./OAuthServerModel`,
 * and `./cimd`. Under this repo's NodeNext module resolution those specifiers
 * do not resolve, and skipLibCheck silently degrades the affected exports
 * (OAuthServer, OAuthServerModel, authenticateHandler, the record types, ...)
 * to `any` — which would leave the OAuth model and consent wiring untyped.
 *
 * This wrapper is a regular module (not an ambient `declare module`, which
 * forbids relative re-exports), so its relative re-exports resolve normally.
 * The deep declaration files use explicit .js specifiers and are fully typed.
 * Runtime imports still resolve through the package root; this file is types
 * only and is never emitted.
 */
export * from '../../node_modules/mcp-oauth-server/dist/schemas.js';
export { OAuthServer, SUPPORTED_GRANT_TYPES, DEFAULT_GRANT_TYPES, SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS } from '../../node_modules/mcp-oauth-server/dist/OAuthServer.js';
export type { OAuthServerOptions, OAuthGrantType } from '../../node_modules/mcp-oauth-server/dist/OAuthServer.js';
export type { OAuthServerModel } from '../../node_modules/mcp-oauth-server/dist/OAuthServerModel.js';
export type {
  AccessToken,
  RefreshToken,
  AuthorizationCode,
  AuthorizationParams,
  AuthInfo,
  ClientIdMetadataDocument,
  DeviceAuthorization,
  DeviceAuthorizationEndpointResponse,
  DeviceAuthorizationStatus,
  GrantId,
} from '../../node_modules/mcp-oauth-server/dist/types.js';
export { DEVICE_AUTHORIZATION_GRANT_TYPE, generateDeviceUserCode, normalizeDeviceUserCode } from '../../node_modules/mcp-oauth-server/dist/deviceFlow.js';
export { authenticateHandler } from '../../node_modules/mcp-oauth-server/dist/handlers/authenticate.js';
export type { AuthenticationHandlerOptions } from '../../node_modules/mcp-oauth-server/dist/handlers/authenticate.js';
export { approveDeviceAuthorizationHandler } from '../../node_modules/mcp-oauth-server/dist/handlers/approveDeviceAuthorization.js';
export type { ApproveDeviceAuthorizationHandlerOptions } from '../../node_modules/mcp-oauth-server/dist/handlers/approveDeviceAuthorization.js';
export { denyDeviceAuthorizationHandler } from '../../node_modules/mcp-oauth-server/dist/handlers/denyDeviceAuthorization.js';
export type { DenyDeviceAuthorizationHandlerOptions } from '../../node_modules/mcp-oauth-server/dist/handlers/denyDeviceAuthorization.js';
export { deviceAuthorizationHandler } from '../../node_modules/mcp-oauth-server/dist/handlers/device.js';
export type { DeviceAuthorizationHandlerOptions } from '../../node_modules/mcp-oauth-server/dist/handlers/device.js';
export { MemoryOAuthServerModel } from '../../node_modules/mcp-oauth-server/dist/MemoryOAuthServerModel.js';
export { AuthorizationPendingError, SlowDownError, ExpiredTokenError, InvalidRequestError, OAuthError, ServerError } from '../../node_modules/mcp-oauth-server/dist/errors.js';
export { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata } from '../../node_modules/mcp-oauth-server/dist/router.js';
export type { AuthRouterOptions, AuthMetadataOptions } from '../../node_modules/mcp-oauth-server/dist/router.js';
export { requireBearerAuth } from '../../node_modules/mcp-oauth-server/dist/middleware/bearerAuth.js';
export type { BearerAuthMiddlewareOptions } from '../../node_modules/mcp-oauth-server/dist/middleware/bearerAuth.js';
export { checkResourceAllowed } from '../../node_modules/mcp-oauth-server/dist/resource-uri.js';
export { redirectUriMatches, isSecureRedirectUri } from '../../node_modules/mcp-oauth-server/dist/redirect-uri.js';
export { isClientIdMetadataDocumentUrl, ClientIdMetadataDocumentFetcher } from '../../node_modules/mcp-oauth-server/dist/cimd.js';
export type { ClientIdMetadataDocumentOptions } from '../../node_modules/mcp-oauth-server/dist/cimd.js';
