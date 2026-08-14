import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { athleteProviderEnvironment, athleteStorePaths, initializeCatalog, providerSecretPath, readAthleteSecrets, resolveCatalogPaths, setAthleteSecret } from '../src/runtime/index.js';

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
});
