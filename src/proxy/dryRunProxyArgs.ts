/** Command-line options of the dry-run proxy entry point (`dist/proxy/dryRun.js`). */
import { parseArgs } from 'node:util';
import { fileToken, staticToken, type TokenSource } from './dryRunProxy.js';

export const DRY_RUN_PROXY_USAGE = `Usage: dryRun --upstream-url <url> --name <label>
  [--token-file <path> | --token-env <NAME>]
  [--header NAME:VALUE]... [--read-only TOOL]... [--always-write TOOL]...
  [--planned-write-alias KEY]...`;

export function parseDryRunProxyArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'upstream-url': { type: 'string' },
      name: { type: 'string' },
      'token-file': { type: 'string' },
      'token-env': { type: 'string' },
      header: { type: 'string', multiple: true, default: [] },
      'read-only': { type: 'string', multiple: true, default: [] },
      'always-write': { type: 'string', multiple: true, default: [] },
      'planned-write-alias': { type: 'string', multiple: true, default: [] },
    },
    strict: true,
  });
  const upstreamUrl = values['upstream-url'];
  const name = values.name;
  if (!upstreamUrl || !name)
    throw new Error('--upstream-url and --name are required.');
  const url = new URL(upstreamUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('--upstream-url must be https, or http on loopback.');
  if (values['token-file'] && values['token-env'])
    throw new Error('Use --token-file or --token-env, not both.');
  let token: TokenSource | undefined;
  if (values['token-file']) token = fileToken(values['token-file']);
  else if (values['token-env']) {
    const value = env[values['token-env']]?.trim();
    if (!value) throw new Error(`${values['token-env']} is not set.`);
    token = staticToken(value);
  }
  const headers: Record<string, string> = {};
  for (const raw of values.header) {
    const colon = raw.indexOf(':');
    if (colon < 1)
      throw new Error(
        `Malformed --header ${JSON.stringify(raw)}; expected NAME:VALUE.`
      );
    headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return {
    upstreamUrl,
    name,
    token,
    headers,
    readOnlyTools: values['read-only'],
    alwaysWriteTools: values['always-write'],
    plannedWriteAliases: values['planned-write-alias'],
  };
}
