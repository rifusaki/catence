#!/usr/bin/env node
import { Command } from 'commander';
import { resolvePaths, type CatencePaths } from '../../core/runtime/configuration.js';
import { connectStrava, dataStatus, disconnectStravaAccount, initializeDataStore, linkActivity, rebuildRetrievalIndex, retryDataSync, syncData, type ProviderChoice, unlinkActivity } from '../../elt/application/management.js';

const program = new Command()
  .name('catence-data')
  .description('Local fitness data extraction, targeted enrichment, and normalization.')
  .option('--data-dir <directory>', 'directory holding the local Catence database and artifacts', process.env.CATENCE_DATA_DIR ?? '.catence');

function currentPaths(): CatencePaths {
  return resolvePaths(program.opts<{ dataDir: string }>().dataDir);
}

program.command('init')
  .description('Create an empty local data store without contacting a provider.')
  .action(async () => {
    process.stdout.write(`${JSON.stringify(await initializeDataStore(currentPaths()), null, 2)}\n`);
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
  .option('--redirect-uri <uri>', 'OAuth redirect URI', 'http://localhost')
  .action(async (options: { code?: string; redirectUri: string }) => {
    process.stdout.write(JSON.stringify(await connectStrava(currentPaths(), options.code, options.redirectUri), null, 2) + "\n");
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
