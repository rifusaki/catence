import { describe, expect, it } from 'vitest';
import { importRecord } from '../../src/elt/ingestion/importer.js';
import { openReadOnlyRepository } from '../../src/elt/storage/database.js';
import { temporaryDatabase } from '../helpers.js';

describe('repository nutrition summary', () => {
  it('returns typed window totals by default and typed per-day rows on request', async () => {
    const { paths, database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-07-30');
    try {
      const base = { kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'garmin' as const, parentRemoteId: null, sourceUpdatedAt: null, rawObjectHash: null, extension: {} };
      await importRecord(database, runId, {
        ...base, entityType: 'nutrition_log', remoteId: '2025-07-30', occurredOn: '2025-07-30',
        payload: { calendarDate: '2025-07-30', totalCalories: 2400, totalCarbs: 315, totalProtein: 130, totalFat: 72, foodItems: [{ id: 'food-1', foodName: 'Oats', quantity: 100, calories: 380, carbs: 65, protein: 13, fat: 7 }] },
      });
      await importRecord(database, runId, {
        ...base, entityType: 'nutrition_log', remoteId: '2025-07-31', occurredOn: '2025-07-31',
        payload: { calendarDate: '2025-07-31', totalCalories: 2600, totalCarbs: 300, totalProtein: 140, totalFat: 80 },
      });
    } finally {
      await database.close();
    }

    const repository = await openReadOnlyRepository(paths);
    const isoDay = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
    try {
      const summary = await repository.summary('2025-07-30', '2025-07-31');
      const totals = summary.nutrition as Array<Record<string, unknown>>;
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({ days_logged: 2, energy_kcal: 5000, carbohydrates_g: 615, protein_g: 270, fat_g: 152 });
      expect(isoDay(totals[0]?.first_date)).toBe('2025-07-30');
      expect(isoDay(totals[0]?.last_date)).toBe('2025-07-31');
      expect(JSON.stringify(totals)).not.toContain('metrics_json');

      const columns = await repository.summary('2025-07-30', '2025-07-31', 'columns');
      const rows = columns.nutrition as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ provider: 'garmin', energy_kcal: 2400, carbohydrates_g: 315, protein_g: 130, fat_g: 72 });
      expect(isoDay(rows[0]?.nutrition_date)).toBe('2025-07-30');
      expect(JSON.stringify(rows)).not.toContain('metrics_json');
    } finally {
      await repository.close();
    }
  });
});
