export type ServeCliOptions = {
  home?: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  help: boolean;
};

export const SERVE_USAGE = `Usage: catence serve [options]

Run Catence as a local Streamable HTTP MCP server.

Options:
  --home <directory>         Catence catalog home. Defaults to CATENCE_HOME or ~/.catence.
  --host <host>              Listener host. Defaults to 127.0.0.1.
  --port <port>              Listener port. Defaults to 8787.
  --allow-origin <origin>    Browser origin allowed to call Catence APIs. May be repeated.
  -h, --help                 Show this help text.`;

function requiredValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('--port must be an integer between 1 and 65535.');
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error('--port must be an integer between 1 and 65535.');
  return port;
}

export function parseServeCliOptions(arguments_: readonly string[]): ServeCliOptions {
  let home: string | undefined;
  let host = process.env.CATENCE_HTTP_HOST ?? '127.0.0.1';
  let port = process.env.CATENCE_HTTP_PORT ? parsePort(process.env.CATENCE_HTTP_PORT) : 8787;
  const allowedOrigins: string[] = [];

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '-h' || argument === '--help') return { home, host, port, allowedOrigins, help: true };
    if (argument === '--home') {
      home = requiredValue(arguments_, index, '--home');
      index++;
      continue;
    }
    if (argument.startsWith('--home=')) {
      home = argument.slice('--home='.length);
      if (!home) throw new Error('--home requires a value.');
      continue;
    }
    if (argument === '--host') {
      host = requiredValue(arguments_, index, '--host');
      index++;
      continue;
    }
    if (argument.startsWith('--host=')) {
      host = argument.slice('--host='.length);
      if (!host) throw new Error('--host requires a value.');
      continue;
    }
    if (argument === '--port') {
      port = parsePort(requiredValue(arguments_, index, '--port'));
      index++;
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length));
      continue;
    }
    if (argument === '--allow-origin') {
      allowedOrigins.push(requiredValue(arguments_, index, '--allow-origin'));
      index++;
      continue;
    }
    if (argument.startsWith('--allow-origin=')) {
      const origin = argument.slice('--allow-origin='.length);
      if (!origin) throw new Error('--allow-origin requires a value.');
      allowedOrigins.push(origin);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { home, host, port, allowedOrigins, help: false };
}
