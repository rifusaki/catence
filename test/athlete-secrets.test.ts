import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { athleteProviderEnvironment, athleteStorePaths, deleteAthleteSecret, describeAthleteSecrets, initializeCatalog, providerSecretPath, readAthleteSecrets, resolveCatalogPaths, setAthleteSecret } from '../src/runtime/index.js';

describe('athlete provider secrets', () => {
  it('keeps each athlete’s provider values in an owner-only local file', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-secrets-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const paths = athleteStorePaths(catalogPaths, 'alex');

    await setAthleteSecret(paths, 'intervals', 'apiKey', 'secret-api-key');
    await setAthleteSecret(paths, 'intervals', 'athleteId', '42');

    expect(await readAthleteSecrets(paths)).toEqual({ intervals: { apiKey: 'secret-api-key', athleteId: '42' } });
    expect(await athleteProviderEnvironment(paths, { INTERVALS_API_KEY: 'shared-process-key' })).toMatchObject({
      INTERVALS_API_KEY: 'secret-api-key',
      INTERVALS_ATHLETE_ID: '42',
    });
    expect((await stat(providerSecretPath(paths))).mode & 0o777).toBe(0o600);
  });

  it('describes which provider fields are configured without exposing values', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-secrets-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const paths = athleteStorePaths(catalogPaths, 'alex');

    expect(await describeAthleteSecrets(paths)).toEqual([
      { id: 'garmin', label: 'Garmin', fields: [{ name: 'email', configured: false }, { name: 'password', configured: false }] },
      { id: 'intervals', label: 'Intervals.icu', fields: [{ name: 'apiKey', configured: false }, { name: 'athleteId', configured: false }] },
      { id: 'strava', label: 'Strava', fields: [{ name: 'clientId', configured: false }, { name: 'clientSecret', configured: false }] },
    ]);

    await setAthleteSecret(paths, 'garmin', 'email', 'athlete@example.test');

    const described = await describeAthleteSecrets(paths);
    expect(described[0].fields).toEqual([{ name: 'email', configured: true }, { name: 'password', configured: false }]);
    expect(JSON.stringify(described)).not.toContain('athlete@example.test');
  });

  it('removes individual fields and drops providers once they are empty', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-secrets-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const paths = athleteStorePaths(catalogPaths, 'alex');

    await setAthleteSecret(paths, 'strava', 'clientId', 'client-id');
    await setAthleteSecret(paths, 'strava', 'clientSecret', 'client-secret');

    await deleteAthleteSecret(paths, 'strava', 'clientId');
    expect(await readAthleteSecrets(paths)).toEqual({ strava: { clientSecret: 'client-secret' } });

    await deleteAthleteSecret(paths, 'strava', 'clientSecret');
    expect(await readAthleteSecrets(paths)).toEqual({});

    await deleteAthleteSecret(paths, 'strava', 'clientSecret');
    expect(await readAthleteSecrets(paths)).toEqual({});

    await expect(deleteAthleteSecret(paths, 'strava', 'nope')).rejects.toThrow('is not a supported strava secret field');
  });
});
