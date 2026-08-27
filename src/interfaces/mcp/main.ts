#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { addAthlete, athleteStorePaths, CatenceDatabase, createDemoStore, defaultCatalogHome, initializeCatalog, loadCatalog, resolveCatalogPaths } from '../../runtime/index.js';
import { parseServeCliOptions, SERVE_USAGE } from '../http/cli-options.js';
import { createCatenceHttpServer } from '../http/server.js';
import { MCP_USAGE, parseMcpCliOptions } from './cli-options.js';
import { createCatenceMcpServer } from './server.js';

async function migrateCatalogStores(home: string | undefined): Promise<void> {
  // On Docker image bumps the DuckDB schema version increases. The
  // read-only MCP health probe would otherwise report "version X required"
  // until the next manual sync. Proactively opening each athlete store in
  // writable mode runs the idempotent migrations (database.ts:migrate)
  // before the HTTP server starts listening, so a plain `docker compose up`
  // after `deploy-console.sh beta` heals existing installs without an extra
  // manual `catence-data migrate --all` step. Failures are best-effort:
  // a missing catalog or a store still locked by another process is retried
  // on the next sync or health check.
  try {
    const catalogPaths = resolveCatalogPaths(home);
    const catalog = await loadCatalog(catalogPaths).catch(() => null);
    if (!catalog || catalog.athletes.length === 0) return;
    for (const athlete of catalog.athletes) {
      const paths = athleteStorePaths(catalogPaths, athlete.id);
      try {
        const database = await CatenceDatabase.open(paths);
        await database.close();
      } catch {
        // Best-effort: a lock or a corrupted store must not prevent the
        // server from starting; the next sync will retry the migration.
      }
    }
  } catch {
    // Catalog read failures are non-fatal for startup.
  }
}

async function run(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === 'serve') {
    const options = parseServeCliOptions(arguments_.slice(1));
    if (options.help) {
      process.stderr.write(`${SERVE_USAGE}\n`);
      return;
    }
    await migrateCatalogStores(options.home);
    const httpServer = createCatenceHttpServer({
      catalogPaths: resolveCatalogPaths(options.home),
      allowedOrigins: options.allowedOrigins,
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    console.error(`Catence Streamable HTTP server is listening at http://${options.host}:${options.port}/mcp`);
    const close = () => {
      httpServer.close(() => process.exit(0));
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  const demo = arguments_[0] === 'demo';
  const options = parseMcpCliOptions(demo ? arguments_.slice(1) : arguments_);
  if (options.help) {
    process.stderr.write(`${MCP_USAGE}\n`);
    return;
  }
  const catalogPaths = resolveCatalogPaths(demo && !options.home ? `${defaultCatalogHome()}-demo` : options.home);
  if (demo) {
    if (!existsSync(catalogPaths.catalog)) {
      await initializeCatalog(catalogPaths, { id: 'demo', label: 'Generated demo athlete' });
    } else if (!(await loadCatalog(catalogPaths)).athletes.some((athlete) => athlete.id === 'demo')) {
      await addAthlete(catalogPaths, { id: 'demo', label: 'Generated demo athlete' });
    }
    const paths = athleteStorePaths(catalogPaths, 'demo');
    const result = await createDemoStore(paths);
    process.stderr.write(`${String(result.message)}\n`);
  }
  const server = createCatenceMcpServer(catalogPaths);
  await server.connect(new StdioServerTransport());
  console.error('Catence MCP server is running on stdio; ordinary tools are read-only and Strava hydration is lock-guarded.');
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`catence: ${message}\n\n${process.argv[2] === 'serve' ? SERVE_USAGE : MCP_USAGE}\n`);
  process.exitCode = 2;
}
