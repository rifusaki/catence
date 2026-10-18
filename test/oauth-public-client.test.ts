import { describe, expect, it } from 'vitest';
import {
  asPublicClientMetadata,
  declaresPrivateKeyJwt,
  PRIVATE_KEY_JWT,
} from '../src/runtime/index.js';

describe('OAuth public-client normalization', () => {
  it('detects the private_key_jwt declaration', () => {
    expect(declaresPrivateKeyJwt({ token_endpoint_auth_method: 'private_key_jwt' })).toBe(true);
    expect(declaresPrivateKeyJwt({ token_endpoint_auth_method: 'none' })).toBe(false);
    expect(declaresPrivateKeyJwt({ token_endpoint_auth_method: 'client_secret_post' })).toBe(false);
    expect(declaresPrivateKeyJwt({})).toBe(false);
    expect(declaresPrivateKeyJwt(null)).toBe(false);
    expect(declaresPrivateKeyJwt('private_key_jwt')).toBe(false);
    expect(PRIVATE_KEY_JWT).toBe('private_key_jwt');
  });

  it('downgrades private_key_jwt to a public client without touching other fields', () => {
    const metadata = {
      client_name: 'OpenAI connector',
      redirect_uris: ['https://chat.openai.com/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      grant_types: ['authorization_code', 'refresh_token'],
    };
    const normalized = asPublicClientMetadata(metadata);
    expect(normalized).toEqual({ ...metadata, token_endpoint_auth_method: 'none' });
    // The input is not mutated.
    expect(metadata.token_endpoint_auth_method).toBe('private_key_jwt');
  });

  it('passes other metadata through unchanged', () => {
    const publicClient = { token_endpoint_auth_method: 'none' };
    expect(asPublicClientMetadata(publicClient)).toBe(publicClient);
    const confidential = { token_endpoint_auth_method: 'client_secret_post' };
    expect(asPublicClientMetadata(confidential)).toBe(confidential);
    const implicit = { client_name: 'x' };
    expect(asPublicClientMetadata(implicit)).toBe(implicit);
    expect(asPublicClientMetadata(null)).toBe(null);
  });
});
