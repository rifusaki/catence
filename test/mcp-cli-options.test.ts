import { describe, expect, it } from 'vitest';
import { MCP_USAGE, parseMcpCliOptions } from '../src/interfaces/mcp/cli-options.js';

describe('MCP CLI options', () => {
  it('accepts an explicit data directory in either supported form', () => {
    expect(parseMcpCliOptions(['--data-dir', '/tmp/catence'])).toEqual({ dataDir: '/tmp/catence', help: false });
    expect(parseMcpCliOptions(['--data-dir=/tmp/catence'])).toEqual({ dataDir: '/tmp/catence', help: false });
  });

  it('keeps help and usage off the MCP stdout transport', () => {
    expect(parseMcpCliOptions(['--help'])).toEqual({ dataDir: undefined, help: true });
    expect(MCP_USAGE).toContain('stdio-only');
  });

  it('rejects missing values and unknown options before starting the server', () => {
    expect(() => parseMcpCliOptions(['--data-dir'])).toThrow('--data-dir requires a directory');
    expect(() => parseMcpCliOptions(['--port', '3000'])).toThrow('Unknown option: --port');
  });
});
