#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolvePaths } from '../../core/runtime/configuration.js';
import { MCP_USAGE, parseMcpCliOptions } from './cli-options.js';
import { createCatenceMcpServer } from './server.js';

try {
  const options = parseMcpCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stderr.write(`${MCP_USAGE}\n`);
  } else {
    const server = createCatenceMcpServer(resolvePaths(options.dataDir));
    await server.connect(new StdioServerTransport());
    console.error('Catence MCP server is running on stdio; ordinary tools are read-only and Strava hydration is lock-guarded.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`catence: ${message}\n\n${MCP_USAGE}\n`);
  process.exitCode = 2;
}
