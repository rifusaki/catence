#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import {
  defaultBearerTokenPath,
  defaultMcpKeysPath,
  defaultOauthSettingsPath,
  disableBearerToken,
  ensureBearerToken,
  mcpExposureStatus,
  oauthStatusFromSettings,
  readBearerToken,
} from '../http/cli-options.js';
import {
  addAthlete,
  addMcpKey,
  athleteStorePaths,
  CATENCE_RUNTIME_VERSION,
  CatenceDatabase,
  channelForVersion,
  createDemoStore,
  dataStatus,
  deleteAthleteSecret,
  defaultCatalogHome,
  disconnectStravaAccount,
  fetchNpmDistTags,
  fetchPypiReleases,
  hasCommand,
  importStagedFile,
  initializeCatalog,
  isGlobalNpmInstall,
  linkActivity,
  listMcpKeys,
  loadCatalog,
  npmGlobalPrefix,
  parseAutoSyncInterval,
  planSelfUpdate,
  readAutoSyncSchedule,
  readInstalledConsoleVersion,
  rebuildRetrievalIndex,
  reimportNutrition,
  reimportWeight,
  resolveExtractionErrors,
  resolveAthlete,
  resolveCatalogPaths,
  retryDataSync,
  revokeMcpKey,
  rollMcpKey,
  runSelfUpdateCommand,
  setAthleteSecret,
  syncData,
  syncProgress,
  connectStrava,
  connectStravaWithCallback,
  unlinkActivity,
  updateAutoSyncSchedule,
  type CatalogPaths,
  type CatencePaths,
  type ProviderChoice,
  type SyncProgressSnapshot,
  type UpdateChannel,
} from '../../runtime/index.js';

const program = new Command()
  .name('catence-data')
  .description('Athlete-scoped Catence data setup, extraction, and normalization.')
  .option('--home <directory>', 'Catence catalog home directory', defaultCatalogHome())
  .option('--athlete <id>', 'athlete ID for a data operation');

function currentCatalog(): CatalogPaths {
  return resolveCatalogPaths(program.opts<{ home: string }>().home);
}

async function currentAthlete(): Promise<{ athlete: { id: string; label: string }; paths: CatencePaths }> {
  const athleteId = program.opts<{ athlete?: string }>().athlete;
  if (!athleteId) throw new Error('--athlete is required for this command. Run catence-data athlete list to inspect the catalog.');
  return resolveAthlete(currentCatalog(), athleteId);
}

async function prompt(question: string): Promise<string> {
  if (!input.isTTY) throw new Error(`Missing required setup value. Re-run with the matching option (${question}).`);
  const terminal = createInterface({ input, output });
  try { return (await terminal.question(question)).trim(); } finally { terminal.close(); }
}

async function stdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!value) throw new Error('--value-stdin received an empty secret.');
  return value;
}

const mcpCommand = program.command('mcp').description('Manage Streamable HTTP MCP exposure: the bearer-token gate, its token, per-account keys, and endpoint URLs.');
const mcpLocalEndpoint = (): string => `http://127.0.0.1:${process.env.CATENCE_HTTP_PORT ?? '8787'}`;
// The keys registry resolves like the serve option: --file, then the
// environment, then the catalog home default.
const mcpKeysFile = (file?: string): string => file ?? process.env.CATENCE_MCP_KEYS_FILE ?? defaultMcpKeysPath(currentCatalog().root);
// The OAuth settings file resolves like the serve option: the environment,
// then the catalog home default.
const mcpOauthSettingsFile = (): string => process.env.CATENCE_OAUTH_SETTINGS_FILE ?? defaultOauthSettingsPath(currentCatalog().root);

mcpCommand.command('status')
  .description('Report whether the bearer-token gate is enabled, the token, the per-account key counts, and the endpoint URLs.')
  .option('--file <path>', 'non-default token file path')
  .action(async (options: { file?: string }) => {
    const tokenFile = options.file ?? defaultBearerTokenPath(currentCatalog().root);
    const keys = await listMcpKeys(mcpKeysFile());
    const status = {
      ...mcpExposureStatus(tokenFile, mcpLocalEndpoint()),
      keys: { total: keys.length, active: keys.filter((key) => key.revokedAt === undefined).length },
      oauth: oauthStatusFromSettings(mcpOauthSettingsFile()),
    };
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  });

mcpCommand.command('enable')
  .description('Enable the bearer-token gate: generate the token file (mode 0600) if it does not exist.')
  .option('--file <path>', 'non-default token file path')
  .action(async (options: { file?: string }) => {
    const tokenFile = options.file ?? defaultBearerTokenPath(currentCatalog().root);
    ensureBearerToken(tokenFile);
    process.stdout.write(`${JSON.stringify(mcpExposureStatus(tokenFile, mcpLocalEndpoint()), null, 2)}\n`);
  });

mcpCommand.command('disable')
  .description('Disable the bearer-token gate by removing the token file. Remote access is refused again.')
  .option('--file <path>', 'non-default token file path')
  .action(async (options: { file?: string }) => {
    const tokenFile = options.file ?? defaultBearerTokenPath(currentCatalog().root);
    disableBearerToken(tokenFile);
    process.stdout.write(`${JSON.stringify(mcpExposureStatus(tokenFile, mcpLocalEndpoint()), null, 2)}\n`);
  });

mcpCommand.command('token')
  .description('Print only the bearer token for pasting into an MCP client credential flow.')
  .option('--file <path>', 'non-default token file path')
  .action(async (options: { file?: string }) => {
    const tokenFile = options.file ?? defaultBearerTokenPath(currentCatalog().root);
    const token = readBearerToken(tokenFile);
    if (token === null) throw new Error(`MCP exposure is not enabled; run 'catence-data mcp enable' first.`);
    process.stdout.write(`${token}\n`);
  });

const mcpKeyCommand = mcpCommand.command('key').description('Manage per-account MCP bearer keys; raw tokens are printed exactly once and stored only as hashes.');

mcpKeyCommand.command('add')
  .description('Create a per-account MCP key and print its raw token exactly once.')
  .requiredOption('--account <username>', 'Console account username the key acts for')
  .option('--label <label>', 'human-readable key label')
  .option('--file <path>', 'non-default MCP keys file path')
  .action(async (options: { account: string; label?: string; file?: string }) => {
    const { record, token } = await addMcpKey(mcpKeysFile(options.file), { account: options.account, label: options.label });
    process.stdout.write(`${JSON.stringify({ id: record.id, label: record.label, account: record.account, createdAt: record.createdAt, token }, null, 2)}\n`);
  });

mcpKeyCommand.command('list')
  .description('List MCP keys without their token hashes.')
  .option('--file <path>', 'non-default MCP keys file path')
  .action(async (options: { file?: string }) => {
    process.stdout.write(`${JSON.stringify({ keys: await listMcpKeys(mcpKeysFile(options.file)) }, null, 2)}\n`);
  });

mcpKeyCommand.command('revoke')
  .description('Revoke an MCP key by id; its token stops working immediately.')
  .argument('<id>', 'key id')
  .option('--file <path>', 'non-default MCP keys file path')
  .action(async (id: string, options: { file?: string }) => {
    await revokeMcpKey(mcpKeysFile(options.file), id);
    process.stdout.write(`${JSON.stringify({ revoked: id }, null, 2)}\n`);
  });

mcpKeyCommand.command('roll')
  .description('Replace an MCP key’s token and print the new raw token exactly once.')
  .argument('<id>', 'key id')
  .option('--file <path>', 'non-default MCP keys file path')
  .action(async (id: string, options: { file?: string }) => {
    const { record, token } = await rollMcpKey(mcpKeysFile(options.file), id);
    process.stdout.write(`${JSON.stringify({ id: record.id, label: record.label, account: record.account, createdAt: record.createdAt, token }, null, 2)}\n`);
  });

program.command('setup')
  .description('Create a home catalog and its first athlete store. Existing 0.1 stores must be re-synced.')
  .option('--athlete <id>', 'first athlete ID')
  .option('--label <label>', 'display label for the first athlete')
  .action(async (options: { athlete?: string; label?: string }) => {
    // Commander resolves the global --athlete option first when it appears
    // after this subcommand, so accept either scope without making the setup
    // command order-sensitive.
    const athlete = options.athlete ?? program.opts<{ athlete?: string }>().athlete ?? await prompt('First athlete ID (for example, alex): ');
    const label = options.label ?? await prompt('First athlete display name: ');
    const catalog = await initializeCatalog(currentCatalog(), { id: athlete, label });
    process.stdout.write(`${JSON.stringify({ home: currentCatalog().root, catalog, message: 'Catence catalog is ready. Add provider values with catence-data secret set --athlete <id> --value-stdin, then run sync.' }, null, 2)}\n`);
  });

const athleteCommand = program.command('athlete').description('Manage isolated athlete stores in this Catence catalog.');
athleteCommand.command('list').action(async () => {
  process.stdout.write(`${JSON.stringify(await loadCatalog(currentCatalog()), null, 2)}\n`);
});
athleteCommand.command('add')
  .requiredOption('--id <id>', 'stable athlete ID')
  .requiredOption('--label <label>', 'display label')
  .option('--default', 'make this the default athlete for Console setup')
  .action(async (options: { id: string; label: string; default?: boolean }) => {
    process.stdout.write(`${JSON.stringify(await addAthlete(currentCatalog(), { id: options.id, label: options.label, setDefault: options.default }), null, 2)}\n`);
  });

const secretCommand = program.command('secret').description('Write or remove a provider value in one athlete’s owner-only secret store.');
secretCommand.command('set')
  .requiredOption('--provider <provider>', 'garmin, intervals, strava, or trainingpeaks')
  .requiredOption('--field <field>', 'provider secret field')
  .requiredOption('--value-stdin', 'read the secret from stdin without putting it in shell history')
  .action(async (options: { provider: 'garmin' | 'intervals' | 'strava' | 'trainingpeaks'; field: string }) => {
    if (!['garmin', 'intervals', 'strava', 'trainingpeaks'].includes(options.provider)) throw new Error('--provider must be garmin, intervals, strava, or trainingpeaks.');
    const { paths } = await currentAthlete();
    await setAthleteSecret(paths, options.provider, options.field, await stdinSecret());
    process.stdout.write(`${JSON.stringify({ athleteId: program.opts<{ athlete: string }>().athlete, provider: options.provider, field: options.field, stored: true }, null, 2)}\n`);
  });

secretCommand.command('remove')
  .requiredOption('--provider <provider>', 'garmin, intervals, or strava')
  .requiredOption('--field <field>', 'provider secret field')
  .action(async (options: { provider: 'garmin' | 'intervals' | 'strava'; field: string }) => {
    if (!['garmin', 'intervals', 'strava'].includes(options.provider)) throw new Error('--provider must be garmin, intervals, or strava.');
    const { paths } = await currentAthlete();
    await deleteAthleteSecret(paths, options.provider, options.field);
    process.stdout.write(`${JSON.stringify({ athleteId: program.opts<{ athlete: string }>().athlete, provider: options.provider, field: options.field, removed: true }, null, 2)}\n`);
  });

program.command('demo')
  .description('Create a generated demo athlete in an isolated demo catalog without contacting providers.')
  .option('--days <days>', 'generated days of wellness and training data', '90')
  .option('--seed <seed>', 'deterministic generator seed', '17')
  .action(async (options: { days: string; seed: string }) => {
    const explicitHome = process.argv.some((argument) => argument === '--home' || argument.startsWith('--home='));
    const demoCatalog = resolveCatalogPaths(explicitHome ? currentCatalog().root : `${defaultCatalogHome()}-demo`);
    let catalog;
    try { catalog = await loadCatalog(demoCatalog); } catch { catalog = await initializeCatalog(demoCatalog, { id: 'demo', label: 'Generated demo athlete' }); }
    if (!catalog.athletes.some((athlete) => athlete.id === 'demo')) {
      catalog = await addAthlete(demoCatalog, { id: 'demo', label: 'Generated demo athlete' });
    }
    const paths = athleteStorePaths(demoCatalog, 'demo');
    const result = await createDemoStore(paths, { days: Number(options.days), seed: Number(options.seed) });
    process.stdout.write(`${JSON.stringify({ ...result, home: demoCatalog.root, athleteId: 'demo' }, null, 2)}\n`);
  });

program.command('sync')
  .requiredOption('--provider <provider>', 'intervals, garmin, strava, trainingpeaks, or all')
  .option('--from <date>', 'explicit ISO date range; otherwise use incremental cursors')
  .option('--refresh', 're-fetch Garmin activity details, files, and streams even when summaries are unchanged')
  .action(async (options: { provider: ProviderChoice; from?: string; refresh?: boolean }) => {
    if (!['intervals', 'garmin', 'strava', 'trainingpeaks', 'all'].includes(options.provider)) throw new Error('--provider must be intervals, garmin, strava, trainingpeaks, or all.');
    const { paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await syncData(paths, options.provider, options.from, true, options.refresh ?? false), null, 2)}\n`);
  });

program.command('backfill')
  .requiredOption('--from <date>', 'ISO date at which to begin backfill')
  .option('--provider <provider>', 'intervals, garmin, strava, trainingpeaks, or all', 'all')
  .option('--refresh', 're-fetch and upsert data already covered by the requested range')
  .action(async (options: { provider: ProviderChoice; from: string; refresh?: boolean }) => {
    if (!['intervals', 'garmin', 'strava', 'trainingpeaks', 'all'].includes(options.provider)) throw new Error('--provider must be intervals, garmin, strava, trainingpeaks, or all.');
    const { paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await syncData(paths, options.provider, options.from, false, options.refresh ?? false, true), null, 2)}\n`);
  });

program.command('retry')
  .requiredOption('--run <run-id>', 'failed run to retry')
  .action(async (options: { run: string }) => {
    const { paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await retryDataSync(paths, options.run), null, 2)}\n`);
  });

const autoSyncCommand = program.command('auto-sync').description('Manage the automatic sync schedule for one athlete. The scheduler runs inside the Catence server (default: enabled, every 2 hours).');

autoSyncCommand.command('status')
  .description('Report the athlete’s automatic sync schedule: enabled flag, interval, and next run.')
  .action(async () => {
    const { athlete, paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await readAutoSyncSchedule(paths, athlete.id), null, 2)}\n`);
  });

autoSyncCommand.command('enable')
  .description('Turn automatic syncing on, optionally changing the interval (15m, 30m, 1h, 2h, 6h, 12h, 24h).')
  .option('--interval <interval>', 'sync interval label or minutes', '2h')
  .action(async (options: { interval: string }) => {
    const { athlete, paths } = await currentAthlete();
    const intervalMinutes = parseAutoSyncInterval(options.interval);
    process.stdout.write(`${JSON.stringify(await updateAutoSyncSchedule(paths, athlete.id, { enabled: true, intervalMinutes }), null, 2)}\n`);
  });

autoSyncCommand.command('disable')
  .description('Turn automatic syncing off. Manual sync keeps working.')
  .action(async () => {
    const { athlete, paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await updateAutoSyncSchedule(paths, athlete.id, { enabled: false }), null, 2)}\n`);
  });

program.command('auth').description('Connect a source account using one athlete’s local credentials.')
  .command('strava')
  .option('--code <authorization-code>', 'OAuth authorization code returned by Strava')
  .option('--redirect-uri <uri>', 'OAuth redirect URI; defaults depend on the selected flow')
  .option('--callback', 'wait for a browser OAuth callback on a loopback redirect URI')
  .option('--timeout-seconds <seconds>', 'maximum callback wait time', '300')
  .action(async (options: { code?: string; redirectUri?: string; callback?: boolean; timeoutSeconds: string }) => {
    if (options.callback && options.code) throw new Error('--code and --callback cannot be used together.');
    const timeoutSeconds = Number(options.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) throw new Error('--timeout-seconds must be an integer between 1 and 900.');
    const { paths } = await currentAthlete();
    const redirectUri = options.redirectUri ?? (options.callback ? 'http://127.0.0.1:8765/strava/callback' : 'http://localhost');
    const result = options.callback
      ? await connectStravaWithCallback(paths, redirectUri, (url) => process.stderr.write(`Open this URL in your browser to connect Strava:\n${url}\nWaiting for the local callback…\n`), timeoutSeconds * 1_000)
      : await connectStrava(paths, options.code, redirectUri);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program.command('disconnect').description('Remove one athlete’s stored provider connection.')
  .command('strava')
  .action(async () => {
    const { paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await disconnectStravaAccount(paths), null, 2)}\n`);
  });

const activityCommand = program.command('activity').description('Audit and correct logical activity links for one athlete.');
activityCommand.command('link').requiredOption('--source <activity-source-id>').requiredOption('--activity <activity-id>').action(async (options: { source: string; activity: string }) => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await linkActivity(paths, options.source, options.activity), null, 2)}\n`);
});
activityCommand.command('unlink').requiredOption('--source <activity-source-id>').action(async (options: { source: string }) => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await unlinkActivity(paths, options.source), null, 2)}\n`);
});

program.command('status').action(async () => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await dataStatus(paths), null, 2)}\n`);
});

function renderProgress(snapshot: SyncProgressSnapshot): string {
  const lines = snapshot.running.map((run) => {
    const pct = run.percentComplete.toFixed(1).padStart(5);
    const units = run.totalUnits !== null ? `${run.completedUnits}/${run.totalUnits}` : String(run.completedUnits);
    const eta = run.estimatedRemainingSeconds !== null ? `${Math.round(run.estimatedRemainingSeconds)}s` : '?';
    const step = run.currentStep ?? '';
    return `${pct}%  ${run.stage.padEnd(12)} ${units.padEnd(11)} ${eta.padEnd(6)} ${step}`;
  });
  return lines.length === 0 ? 'no active sync runs' : lines.join('\n');
}

program.command('progress')
  .description('Show live progress for active sync runs.')
  .option('--watch', 'refresh every few seconds until no sync runs are active')
  .action(async (options: { watch?: boolean }) => {
    const { paths } = await currentAthlete();
    if (!options.watch) {
      process.stdout.write(`${JSON.stringify(await syncProgress(paths), null, 2)}\n`);
      return;
    }
    while (true) {
      const snapshot = await syncProgress(paths);
      if (output.isTTY) {
        output.write(`\x1b[2J\x1b[H${renderProgress(snapshot)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      }
      if (snapshot.running.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  });

program.command('update')
  .description('Check for and apply the newest Catence release on the tracked channel (runtime and Console).')
  .option('--check', 'report available releases without changing anything')
  .option('--channel <stable|beta>', 'release channel to track; defaults to the installed runtime channel')
  .option('--runtime', 'only check or update the Catence runtime package')
  .option('--console', 'only check or update the Catence Console package')
  .action(async (options: { check?: boolean; channel?: string; runtime?: boolean; console?: boolean }) => {
    if (options.channel !== undefined && options.channel !== 'stable' && options.channel !== 'beta') {
      throw new Error('--channel must be stable or beta.');
    }
    const channel: UpdateChannel = options.channel ?? channelForVersion(CATENCE_RUNTIME_VERSION);
    const runtimeOnly = options.runtime ?? false;
    const consoleOnly = options.console ?? false;
    const updateRuntime = runtimeOnly || !consoleOnly;
    const updateConsole = consoleOnly || !runtimeOnly;
    const [npmDistTags, pypiReleases, consoleInstalled] = await Promise.all([
      fetchNpmDistTags('catence'),
      fetchPypiReleases('catence-console'),
      readInstalledConsoleVersion(),
    ]);
    const plan = planSelfUpdate({ runtimeVersion: CATENCE_RUNTIME_VERSION, channel, npmDistTags, pypiReleases, consoleInstalled });
    const report = { channel, runtime: plan.runtime, console: plan.console };
    if (options.check) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(plan.ok ? 0 : 1);
    }
    const applied: string[] = [];
    if (plan.runtime.updateAvailable && updateRuntime) {
      const runtimeTarget = plan.runtime.target;
      if (runtimeTarget === undefined) throw new Error('No runtime update target is available.');
      const npmPrefix = await npmGlobalPrefix();
      if (isGlobalNpmInstall(import.meta.url, npmPrefix)) {
        const exitCode = await runSelfUpdateCommand('npm', ['install', '--global', `catence@${runtimeTarget}`]);
        if (exitCode !== 0) throw new Error(`npm failed to install catence@${runtimeTarget} (exit ${exitCode}).`);
        applied.push(`runtime: catence@${runtimeTarget}`);
      } else {
        process.stderr.write(`Runtime is not a global npm install; run: npm install --global catence@${runtimeTarget}\n`);
      }
    }
    if (plan.console.updateAvailable && updateConsole) {
      const consoleTarget = plan.console.target;
      if (consoleTarget === undefined) throw new Error('No Console update target is available.');
      if (await hasCommand('uv')) {
        const exitCode = await runSelfUpdateCommand('uv', ['tool', 'install', '--upgrade', `catence-console==${consoleTarget}`]);
        if (exitCode !== 0) throw new Error(`uv failed to install catence-console==${consoleTarget} (exit ${exitCode}).`);
        applied.push(`console: catence-console==${consoleTarget}`);
      } else {
        process.stderr.write(`uv is not installed; run: pip install --upgrade 'catence-console==${consoleTarget}'\n`);
      }
    }
    process.stdout.write(`${JSON.stringify({ ...report, applied }, null, 2)}\n`);
  });
program.command('build-retrieval-index').description('Build derived local retrieval context for one athlete.').action(async () => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await rebuildRetrievalIndex(paths), null, 2)}\n`);
});
program.command('reimport-nutrition').description('Re-run normalization over captured nutrition entities without contacting providers.').action(async () => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await reimportNutrition(paths), null, 2)}\n`);
});
program.command('reimport-weight').description('Backfill weight_kg from captured Garmin weigh-in entities without contacting providers.').action(async () => {
  const { paths } = await currentAthlete();
  process.stdout.write(`${JSON.stringify(await reimportWeight(paths), null, 2)}\n`);
});
program
  .command('import')
  .description('Import a staged JSONL file (for example a swim-length backfill) into one athlete’s data store.')
  .requiredOption('--provider <provider>', 'garmin, intervals, or strava')
  .argument('<file>', 'path to the staged JSONL file')
  .action(async (file: string, options: { provider: ProviderChoice }) => {
    const { paths } = await currentAthlete();
    process.stdout.write(`${JSON.stringify(await importStagedFile(paths, options.provider, file), null, 2)}\n`);
  });
program
  .command('resolve-errors')
  .description('Mark unresolved extraction errors as resolved (for example stale bootstrap failures from an environment that has since recovered).')
  .option('--run <run-id>', 'resolve errors from a specific run only (repeatable)')
  .option('--provider <provider>', 'resolve errors for garmin, intervals, or strava only')
  .option('--before <timestamp>', 'resolve errors created before this ISO timestamp')
  .option('--all', 'resolve every unresolved error')
  .action(async (options: { run?: string | string[]; provider?: string; before?: string; all?: boolean }) => {
    const { paths } = await currentAthlete();
    const runIds = Array.isArray(options.run) ? options.run : options.run ? [options.run] : undefined;
    process.stdout.write(`${JSON.stringify(await resolveExtractionErrors(paths, { runIds, provider: options.provider, before: options.before, all: options.all }), null, 2)}\n`);
  });

program
  .command('migrate')
  .description('Apply pending DuckDB schema migrations. Without --all it migrates the selected --athlete store; with --all it migrates every athlete in the catalog.')
  .option('--all', 'migrate every athlete in the catalog')
  .option('--home <directory>', 'Catence catalog home directory (also accepts global --home)')
  .action(async (options: { all?: boolean; home?: string }) => {
    const effectiveHome = options.home ?? program.opts<{ home: string }>().home;
    const effectiveCatalog = effectiveHome ? resolveCatalogPaths(effectiveHome) : currentCatalog();
    const migratePaths = async (paths: CatencePaths): Promise<Record<string, unknown>> => {
      const database = await CatenceDatabase.open(paths);
      const applied = await database.rows<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
      await database.close();
      return { migrated: true, appliedVersions: applied.map((row) => row.version) };
    };
    if (options.all) {
      const catalog = await loadCatalog(effectiveCatalog);
      const results: Record<string, unknown> = {};
      for (const athlete of catalog.athletes) {
        const paths = athleteStorePaths(effectiveCatalog, athlete.id);
        try {
          results[athlete.id] = await migratePaths(paths);
        } catch (error) {
          results[athlete.id] = { migrated: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      process.stdout.write(`${JSON.stringify({ catalog: effectiveCatalog.root, results }, null, 2)}\n`);
      return;
    }
    const athleteId = program.opts<{ athlete?: string }>().athlete;
    if (!athleteId) throw new Error('--athlete is required for this command. Run catence-data athlete list to inspect the catalog or use --all.');
    const { athlete, paths } = await resolveAthlete(effectiveCatalog, athleteId);
    const result = await migratePaths(paths);
    process.stdout.write(`${JSON.stringify({ athleteId: athlete.id, ...result }, null, 2)}\n`);
  });

await program.parseAsync();
