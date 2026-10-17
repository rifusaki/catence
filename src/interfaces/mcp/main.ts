#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { addAthlete, athleteStorePaths, CatenceDatabase, createDemoStore, defaultCatalogHome, initializeCatalog, loadCatalog, resolveCatalogPaths, startAutoSyncScheduler } from '../../runtime/index.js';
import { defaultBearerTokenPath, defaultMcpKeysPath, defaultOauthSettingsPath, oauthStatusFromSettings, parseServeCliOptions, SERVE_USAGE } from '../http/cli-options.js';
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
    const catalogPaths = resolveCatalogPaths(options.home);
    const mcpKeysFile = options.mcpKeysFile ?? defaultMcpKeysPath(catalogPaths.root);
    const oauthSettingsFile = options.oauthSettingsFile ?? defaultOauthSettingsPath(catalogPaths.root);
    const httpServer = createCatenceHttpServer({
      catalogPaths,
      allowedOrigins: options.allowedOrigins,
      // The token file's presence switches authentication on; enable it with
      // `catence-data mcp enable` (or the Console Settings / exposure API).
      bearerTokenFile: options.authTokenFile ?? defaultBearerTokenPath(catalogPaths.root),
      // Any active per-account key in the registry arms the gate too; manage
      // keys with `catence-data mcp key`.
      mcpKeysFile,
      // The Console-managed settings file overrides the startup --oauth flag at
      // runtime; the Express sub-app builds lazily on first effective use.
      oauthSettingsFile,
      // The OAuth authorization server (express is loaded lazily inside the
      // server) serves /.well-known/oauth-* and /oauth/* and verifies tokens
      // at the gate; requires the https --public-url validated at parse time.
      ...(options.oauth && options.publicUrl ? { oauth: { publicUrl: options.publicUrl } } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    console.error(`Catence Streamable HTTP server is listening at http://${options.host}:${options.port}/mcp`);
    console.error(`Bearer-token authentication is armed at ${options.authTokenFile ?? defaultBearerTokenPath(catalogPaths.root)}; enable it with 'catence-data mcp enable'. Health endpoints stay open for readiness probes.`);
    console.error(`Per-account MCP keys are read from ${mcpKeysFile}; manage them with 'catence-data mcp key'.`);
    const oauthStatus = oauthStatusFromSettings(oauthSettingsFile);
    if (oauthStatus.enabled && oauthStatus.publicUrl) {
      console.error(`OAuth 2.1 authorization server is enabled (${oauthStatus.source}); issuer ${oauthStatus.publicUrl}, consent at ${oauthStatus.publicUrl}/oauth/consent.`);
    } else {
      console.error('OAuth 2.1 authorization server is disabled; enable it from the Console (Settings, MCP exposure tab) or with CATENCE_OAUTH_ENABLED=1 and CATENCE_PUBLIC_URL.');
    }
    // Auto-sync runs while the server is up: each athlete's autosync.json
    // (default: enabled, every 2 hours) triggers a detached sync. The
    // detached child and the single-writer DuckDB lock stay the only
    // executors, so concurrent ticks are no-ops by design.
    const scheduler = startAutoSyncScheduler({ catalogPaths });
    console.error('Auto-sync scheduler started (default: enabled, every 2 hours per athlete; configure with auto-sync enable --interval or Console Settings).');
    const close = () => {
      scheduler.stop();
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
