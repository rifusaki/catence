import { describe, expect, it } from 'vitest';
import { openReadOnlyRepository } from '../../src/elt/storage/database.js';
import { temporaryDatabase } from '../helpers.js';

describe('DuckDB database lifecycle', () => {
  it('closes writable and read-only handles cleanly', async () => {
    const { paths, database } = await temporaryDatabase();
    const status = await database.status();
    expect(status).toMatchObject({ activities: 0, streams: 0 });
    await database.close();
    await expect(database.close()).resolves.toBeUndefined();

    const repository = await openReadOnlyRepository(paths);
    try {
      expect(await repository.rows('SELECT count(*) AS count FROM daily_metrics')).toEqual([{ count: 0n }]);
    } finally {
      await repository.close();
    }
  });
});
