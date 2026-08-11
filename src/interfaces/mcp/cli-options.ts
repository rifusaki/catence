export type McpCliOptions = {
  dataDir?: string;
  help: boolean;
};

export const MCP_USAGE = `Usage: catence [--data-dir <directory>]
       catence demo [--data-dir <directory>]

Run Catence as a local, stdio-only MCP server. Ordinary data access is read-only; only declared Strava hydration tools write through the locked local store.

The demo command creates safe generated data in ./catence-demo by default, then starts the same MCP server. It refuses to overwrite a non-demo data directory.

Options:
  --data-dir <directory>  Catence data directory. Overrides CATENCE_DATA_DIR.
  -h, --help              Show this help text.`;

export function parseMcpCliOptions(arguments_: readonly string[]): McpCliOptions {
  let dataDir: string | undefined;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '-h' || argument === '--help') return { dataDir, help: true };
    if (argument === '--data-dir') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--data-dir requires a directory.');
      dataDir = value;
      index++;
      continue;
    }
    if (argument.startsWith('--data-dir=')) {
      const value = argument.slice('--data-dir='.length);
      if (!value) throw new Error('--data-dir requires a directory.');
      dataDir = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { dataDir, help: false };
}
