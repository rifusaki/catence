/** Embed an internally-derived literal in a SQL relation expression. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
