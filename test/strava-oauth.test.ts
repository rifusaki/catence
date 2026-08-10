import { describe, expect, it } from 'vitest';
import { loopbackStravaRedirect } from '../src/elt/application/management.js';

describe('Strava loopback OAuth callback', () => {
  it('accepts only an explicit local HTTP callback listener', () => {
    const callback = loopbackStravaRedirect('http://127.0.0.1:8765/strava/callback');
    expect(callback.hostname).toBe('127.0.0.1');
    expect(callback.port).toBe('8765');
    expect(callback.pathname).toBe('/strava/callback');
  });

  it.each([
    'https://127.0.0.1:8765/callback',
    'http://example.test:8765/callback',
    'http://localhost/callback',
    'not-a-url',
  ])('rejects unsafe or non-listening redirect URI %s', (redirectUri) => {
    expect(() => loopbackStravaRedirect(redirectUri)).toThrow();
  });
});
