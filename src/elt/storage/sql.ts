export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}
