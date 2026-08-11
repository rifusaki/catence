#!/usr/bin/env node
import { Command } from 'commander';
import { connectStrava, connectStravaWithCallback, createDemoStore, dataStatus, disconnectStravaAccount, initializeDataStore, linkActivity, rebuildRetrievalIndex, resolvePaths, retryDataSync, syncData, type CatencePaths, type ProviderChoice, unlinkActivity } from '../../runtime/index.js';

const program = new Command()
  .name('catence-data')
  .description('Local fitness data extraction, targeted enrichment, and normalization.')
  .option('--data-dir <directory>', 'directory holding the local Catence database and artifacts', process.env.CATENCE_DATA_DIR ?? '.catence');

function currentPaths(): CatencePaths {
  return resolvePaths(program.opts<{ dataDir: string }>().dataDir);
}

function demoPaths(): CatencePaths {
  const dataDirWasProvided = process.argv.some((argument) => argument === '--data-dir' || argument.startsWith('--data-dir='));
  const dataDir = dataDirWasProvided || process.env.CATENCE_DATA_DIR
    ? program.opts<{ dataDir: string }>().dataDir
    : './catence-demo';
  return resolvePaths(dataDir);
}

program.command('init')
  .description('Create an empty local data store without contacting a provider.')
  .action(async () => {
    process.stdout.write(`${JSON.stringify(await initializeDataStore(currentPaths()), null, 2)}\n`);
  });

program.command('demo')
  .description('Create a generated local demo store without contacting providers. Refuses to overwrite a non-demo data directory.')
  .option('--days <days>', 'generated days of wellness and training data', '90')
  .option('--seed <seed>', 'deterministic generator seed', '17')
  .action(async (options: { days: string; seed: string }) => {
    const days = Number(options.days);
    const seed = Number(options.seed);
    process.stdout.write(`${JSON.stringify(await createDemoStore(demoPaths(), { days, seed }), null, 2)}\n`);
  });

program.command('sync')
  .requiredOption('--provider <provider>', 'intervals, garmin, strava, or all')
  .option('--from <date>', 'explicit ISO date range; otherwise use incremental cursors')
  .option('--refresh', 're-fetch Garmin activity details, files, and streams even when summaries are unchanged')
  .action(async (options: { provider: ProviderChoice; from?: string; refresh?: boolean }) => {
    if (!['intervals', 'garmin', 'strava', 'all'].includes(options.provider)) throw new Error('--provider must be intervals, garmin, strava, or all.');
    process.stdout.write(`${JSON.stringify(await syncData(currentPaths(), options.provider, options.from, true, options.refresh ?? false), null, 2)}\n`);
  });

program.command('backfill')
  .requiredOption('--from <date>', 'ISO date at which to begin backfill')
  .option('--provider <provider>', 'intervals, garmin, strava, or all', 'all')
  .option('--refresh', 're-fetch and upsert data already covered by the requested range (including Garmin activity details, files, and streams)')
  .action(async (options: { provider: ProviderChoice; from: string; refresh?: boolean }) => {
    if (!['intervals', 'garmin', 'strava', 'all'].includes(options.provider)) throw new Error('--provider must be intervals, garmin, strava, or all.');
    process.stdout.write(`${JSON.stringify(await syncData(currentPaths(), options.provider, options.from, false, options.refresh ?? false, true), null, 2)}\n`);
  });

program.command('retry')
  .requiredOption('--run <run-id>', 'failed run to retry')
  .action(async (options: { run: string }) => {
    process.stdout.write(`${JSON.stringify(await retryDataSync(currentPaths(), options.run), null, 2)}\n`);
  });

program.command('auth').description('Connect a source account without storing credentials in DuckDB.')
  .command('strava')
  .option('--code <authorization-code>', 'OAuth authorization code returned by Strava')
  .option('--redirect-uri <uri>', 'OAuth redirect URI; defaults depend on the selected flow')
  .option('--callback', 'wait for a browser OAuth callback on a loopback redirect URI')
  .option('--timeout-seconds <seconds>', 'maximum callback wait time', '300')
  .action(async (options: { code?: string; redirectUri?: string; callback?: boolean; timeoutSeconds: string }) => {
    if (options.callback && options.code) throw new Error('--code and --callback cannot be used together.');
    const timeoutSeconds = Number(options.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) throw new Error('--timeout-seconds must be an integer between 1 and 900.');
    const redirectUri = options.redirectUri ?? (options.callback ? 'http://127.0.0.1:8765/strava/callback' : 'http://localhost');
    const result = options.callback
      ? await connectStravaWithCallback(currentPaths(), redirectUri, (url) => {
        process.stderr.write(`Open this URL in your browser to connect Strava:\n${url}\nWaiting for the local callback…\n`);
      }, timeoutSeconds * 1_000)
      : await connectStrava(currentPaths(), options.code, redirectUri);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  });

program.command('disconnect').description('Remove locally stored credentials for a source account.')
  .command('strava')
  .action(async () => {
    process.stdout.write(JSON.stringify(await disconnectStravaAccount(currentPaths()), null, 2) + "\n");
  });

const activityCommand = program.command('activity').description('Audit and correct logical activity links.');
activityCommand.command('link')
  .requiredOption('--source <activity-source-id>')
  .requiredOption('--activity <activity-id>')
  .action(async (options: { source: string; activity: string }) => {
    process.stdout.write(JSON.stringify(await linkActivity(currentPaths(), options.source, options.activity), null, 2) + "\n");
  });
activityCommand.command('unlink')
  .requiredOption('--source <activity-source-id>')
  .action(async (options: { source: string }) => {
    process.stdout.write(JSON.stringify(await unlinkActivity(currentPaths(), options.source), null, 2) + "\n");
  });

program.command('status').action(async () => {
  process.stdout.write(`${JSON.stringify(await dataStatus(currentPaths()), null, 2)}\n`);
});

program.command('build-retrieval-index')
  .description('Build the derived local text-retrieval index after a completed sync.')
  .action(async () => {
    process.stdout.write(`${JSON.stringify(await rebuildRetrievalIndex(currentPaths()), null, 2)}\n`);
  });

await program.parseAsync();
