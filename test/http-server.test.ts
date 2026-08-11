import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatenceHttpServer } from '../src/interfaces/http/server.js';
import { temporaryDatabase } from './helpers.js';

const servers: Array<ReturnType<typeof createCatenceHttpServer>> = [];

async function listen(server: ReturnType<typeof createCatenceHttpServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Catence Streamable HTTP server', () => {
  it('serves health and the existing MCP catalog', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const server = createCatenceHttpServer({ paths, allowedOrigins: ['http://127.0.0.1:8000'] });
    servers.push(server);
    const origin = await listen(server);

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: 'ok',
      service: 'catence',
      runtimeVersion: '0.1.0',
      protocolVersion: 1,
      capabilities: { mcp: true, dashboardApi: 1, demoStore: true },
    });

    const dashboard = await fetch(`${origin}/api/v1/dashboard?endDate=2026-08-09&days=7`);
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toEqual(expect.objectContaining({
      period: { startDate: '2026-08-03', endDate: '2026-08-09', days: 7 },
      health: [],
      training: { weeks: [] },
      activities: [],
    }));

    const client = new Client({ name: 'catence-http-test-client', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['catence_status', 'describe_data', 'read_series']));
    } finally {
      await client.close();
    }
  });

  it('enforces the configured browser origins', async () => {
    const server = createCatenceHttpServer({ allowedOrigins: ['http://127.0.0.1:8000'] });
    servers.push(server);
    const origin = await listen(server);

    const rejected = await fetch(`${origin}/health`, { headers: { origin: 'http://example.test' } });
    expect(rejected.status).toBe(403);
    const allowed = await fetch(`${origin}/health`, { headers: { origin: 'http://127.0.0.1:8000' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8000');

    const invalidDashboard = await fetch(`${origin}/api/v1/dashboard?days=0`);
    expect(invalidDashboard.status).toBe(400);
  });
});
