/**
 * Storage boundary used by Catence core. Implementations may use DuckDB or a
 * test double, but core logic does not depend on a database driver.
 */
export type QueryValues = Record<string, unknown>;
export type QueryBindings = QueryValues | unknown[];

export interface ReadDataStore {
  close(): Promise<void>;
  rows<T extends Record<string, unknown>>(sql: string, values?: QueryBindings): Promise<T[]>;
  tableNames(query: string): Promise<string[]>;
  interrupt(): void;
}

export interface WriteDataStore extends ReadDataStore {
  run(sql: string, values?: QueryBindings): Promise<void>;
}
