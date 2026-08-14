import { describe, expect, it } from 'vitest';
import { parseServeCliOptions, SERVE_USAGE } from '../src/interfaces/http/cli-options.js';

describe('parseServeCliOptions', () => {
  it('uses local-only defaults', () => {
    expect(parseServeCliOptions([])).toEqual({ home: undefined, host: '127.0.0.1', port: 8787, allowedOrigins: [], help: false });
  });

  it('accepts server and browser options', () => {
    expect(parseServeCliOptions([
      '--home', '/tmp/catence', '--host=0.0.0.0', '--port', '9000', '--allow-origin', 'http://127.0.0.1:8000', '--allow-origin=http://localhost:8000',
    ])).toEqual({
      home: '/tmp/catence', host: '0.0.0.0', port: 9000, allowedOrigins: ['http://127.0.0.1:8000', 'http://localhost:8000'], help: false,
    });
  });

  it('rejects invalid ports and unknown options', () => {
    expect(() => parseServeCliOptions(['--port', '0'])).toThrow('between 1 and 65535');
    expect(() => parseServeCliOptions(['--nope'])).toThrow('Unknown option: --nope');
  });

  it('shows serve-specific help', () => {
    expect(parseServeCliOptions(['--help']).help).toBe(true);
    expect(SERVE_USAGE).toContain('Streamable HTTP');
  });
});
