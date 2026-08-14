export type McpCliOptions = {
  home?: string;
  help: boolean;
};

export const MCP_USAGE = `Usage: catence [--home <directory>]
       catence demo [--home <directory>]

Run Catence as a local, stdio-only MCP server. Ordinary data access is read-only; only declared Strava hydration tools write through the locked local store.

The demo command creates safe generated data in ~/.catence-demo by default, then starts the same shared-athlete MCP server. It refuses to overwrite a non-demo athlete store.

Options:
  --home <directory>      Catence catalog home. Defaults to CATENCE_HOME or ~/.catence.
  -h, --help              Show this help text.`;

export function parseMcpCliOptions(arguments_: readonly string[]): McpCliOptions {
  let home: string | undefined;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '-h' || argument === '--help') return { home, help: true };
    if (argument === '--home') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--home requires a directory.');
      home = value;
      index++;
      continue;
    }
    if (argument.startsWith('--home=')) {
      const value = argument.slice('--home='.length);
      if (!value) throw new Error('--home requires a directory.');
      home = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { home, help: false };
}
