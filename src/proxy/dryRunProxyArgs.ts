/** Command-line options of the dry-run proxy entry point (`dist/proxy/dryRun.js`). */
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { fileToken, staticToken, type TokenSource } from './dryRunProxy.js';

export const DRY_RUN_PROXY_USAGE = `Usage: dryRun --upstream-url <url> --name <label>
  [--token-file <path> | --token-env <NAME>]
  [--header NAME:VALUE]... [--read-only TOOL]... [--always-write TOOL]...
  [--planned-write-alias KEY]... [--request-timeout-ms <ms>]
  [--write-record <file>] [--dispatcher TOOL=ARGUMENT]...
  [--forward-writes [--planned-write-key KEY] | --simulate-writes [--write-replies <json>]]`;

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
      'forward-writes': { type: 'boolean', default: false },
      'planned-write-key': { type: 'string' },
      dispatcher: { type: 'string', multiple: true, default: [] },
      'request-timeout-ms': { type: 'string' },
      'write-record': { type: 'string' },
      'simulate-writes': { type: 'boolean', default: false },
      'write-replies': { type: 'string' },
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
  const simulate = values['simulate-writes'];
  const writeRecord = values['write-record'];
  if (values['forward-writes'] && simulate)
    throw new Error('Use --forward-writes or --simulate-writes, not both.');
  if (values['planned-write-key'] !== undefined && !values['forward-writes'])
    throw new Error('--planned-write-key needs --forward-writes.');
  if (simulate && !writeRecord)
    throw new Error(
      "--simulate-writes needs --write-record: a simulated write MST can't see is never answered as done."
    );
  if (writeRecord !== undefined && !isAbsolute(writeRecord))
    throw new Error('--write-record takes an absolute path.');
  const dispatchers: Record<string, string> = {};
  for (const raw of values.dispatcher) {
    const equals = raw.indexOf('=');
    if (equals < 1 || equals === raw.length - 1)
      throw new Error(
        `Malformed --dispatcher ${JSON.stringify(raw)}; expected TOOL=ARGUMENT.`
      );
    dispatchers[raw.slice(0, equals)] = raw.slice(equals + 1);
  }
  let requestTimeoutMs: number | undefined;
  if (values['request-timeout-ms'] !== undefined) {
    requestTimeoutMs = Number(values['request-timeout-ms']);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
      throw new Error('--request-timeout-ms takes a positive whole number.');
  }
  if (values['write-replies'] !== undefined && !simulate)
    throw new Error('--write-replies needs --simulate-writes.');
  let replies: Record<string, unknown> | undefined;
  if (values['write-replies'] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values['write-replies']);
    } catch {
      throw new Error('--write-replies must be a JSON object.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('--write-replies must be a JSON object.');
    replies = parsed as Record<string, unknown>;
  }
  return {
    upstreamUrl,
    name,
    token,
    headers,
    readOnlyTools: values['read-only'],
    alwaysWriteTools: values['always-write'],
    plannedWriteAliases: values['planned-write-alias'],
    ...(values['forward-writes'] ? { forwardWrites: true } : {}),
    ...(values['planned-write-key'] !== undefined
      ? { plannedWriteKey: values['planned-write-key'] }
      : {}),
    ...(Object.keys(dispatchers).length > 0 ? { dispatchers } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(writeRecord ? { writeRecord } : {}),
    ...(simulate ? { simulateWrites: true } : {}),
    ...(replies ? { writeReplies: replies } : {}),
  };
}
