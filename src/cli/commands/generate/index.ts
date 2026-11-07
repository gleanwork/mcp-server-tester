/**
 * `mst generate`: call an MCP server's tools and write a Playwright test per
 * call, with assertions suggested from the response.
 *
 * With `--tool`, it records that one call from flags and asks nothing, so an
 * agent or a script can run it: `mst generate --config mcp.json --tool search
 * --args '{"query":"x"}'`. Run it again to add more tests to the same spec.
 * Without `--tool`, it asks in a terminal which tools to call and which
 * assertions to keep.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Client, Tool } from '@modelcontextprotocol/client';
import { CLIOAuthClient } from '../../../auth/cli.js';
import { listKnownServers } from '../../../auth/storage.js';
import {
  isHttpConfig,
  type MCPConfig,
  validateMCPConfig,
} from '../../../config/mcpConfig.js';
import { callToolNormalized } from '../../../mcp/callTool.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../mcp/clientFactory.js';
import { suggestAssertions } from '../../utils/assertionSuggester.js';
import { splitCommandLine } from '../../utils/commandLine.js';
import { jsonPreview, status } from '../../utils/format.js';
import {
  createPrompter,
  isInteractive,
  missingFlagError,
  PromptCancelledError,
  type Prompter,
} from '../../utils/prompt.js';
import {
  appendToolChecks,
  canAppendToolChecks,
  renderToolTestSpec,
  type ToolCheck,
} from '../../utils/toolTestSpec.js';

export interface GenerateOptions {
  /** A JSON file holding an MCP config. */
  config?: string;
  /** An HTTP server's URL, instead of `config`. */
  url?: string;
  /** The command that starts a stdio server, instead of `config`. */
  command?: string;
  output?: string;
  snapshot?: boolean;
  /** Record one call to this tool from flags, without asking. */
  tool?: string;
  /** The call's arguments, as a JSON object (default `{}`). */
  args?: string;
  /** The test's title (default `<tool>-<n>`). */
  name?: string;
  description?: string;
  /** The `describe` name of a new spec (default `MCP tools`). */
  suite?: string;
  /** Also assert the exact response. */
  exact?: boolean;
}

const DEFAULT_OUTPUT = 'tests/generated.spec.ts';
const DEFAULT_SUITE = 'MCP tools';
const ROOTS = { roots: { listChanged: true } };

class AuthRequiredError extends Error {
  constructor(readonly config: MCPConfig) {
    super('Authentication required');
  }
}

export async function generate(options: GenerateOptions): Promise<void> {
  const oneShot = options.tool !== undefined;
  const prompter = !oneShot && isInteractive() ? createPrompter() : null;
  let client: Client | null = null;
  let cancelled = false;
  try {
    if (!oneShot && !prompter) {
      throw missingFlagError('--tool <name> (with --args <json>)', 'a tool');
    }
    // Checked before connecting, so a typo doesn't start the server.
    const args = oneShot ? parseArgsFlag(options.args) : {};
    const config = await resolveConfig(options, prompter);
    print('Connecting to MCP server...');
    const connecting = connect(config);
    // Closes a client that connects after Ctrl+C.
    connecting.then(
      async (late) => {
        if (cancelled) await closeMCPClient(late).catch(() => {});
      },
      () => {}
    );
    client = await untilCancelled(connecting, prompter);
    const tools = await untilCancelled(listTools(client, config), prompter);
    print(status('success', `Connected! Found ${tools.length} tools`));

    const outputPath = resolve(options.output ?? DEFAULT_OUTPUT);
    const existing = await specToAppend(outputPath, prompter);
    const suite =
      existing !== null
        ? DEFAULT_SUITE
        : (options.suite ??
          (prompter
            ? await prompter.text('Test suite name', DEFAULT_SUITE)
            : DEFAULT_SUITE));
    const titles = new Set(existing === null ? [] : testTitles(existing));

    const checks: ToolCheck[] = [];
    if (prompter) {
      await recordInteractively(client, tools, options, prompter, {
        checks,
        titles,
      });
    } else {
      checks.push(await recordFromFlags(client, tools, options, args, titles));
    }
    if (checks.length === 0) {
      print('No tests added.');
      return;
    }

    print('Saving spec...');
    const source =
      existing !== null
        ? appendToolChecks(existing, checks)
        : renderToolTestSpec(suite, checks);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source);
    printDone(outputPath, checks);
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      cancelled = true;
      process.exitCode = 130;
    } else if (error instanceof AuthRequiredError) {
      printAuthRequired(error.config);
      process.exitCode = 1;
    } else {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    prompter?.close();
    if (client) await closeMCPClient(client).catch(() => {});
  }
  // A connect still in flight would keep the process alive until the server
  // answers or times out.
  if (cancelled) process.exit(130);
}

/** `work`, or `PromptCancelledError` as soon as the user presses Ctrl+C. */
async function untilCancelled<T>(
  work: Promise<T>,
  prompter: Prompter | null
): Promise<T> {
  return prompter ? Promise.race([work, prompter.cancelled]) : work;
}

/** The MCP config from flags, or from prompts in a terminal. */
async function resolveConfig(
  options: GenerateOptions,
  prompter: Prompter | null
): Promise<MCPConfig> {
  const given = [options.config, options.url, options.command].filter(
    (value) => value !== undefined
  );
  if (given.length > 1) {
    throw new Error('Pass one of --config, --url or --command.');
  }
  if (options.config !== undefined) {
    try {
      const content = await readFile(resolve(options.config), 'utf-8');
      return validateMCPConfig(JSON.parse(content));
    } catch (error) {
      throw new Error(
        `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (options.url !== undefined) return httpConfig(options.url);
  if (options.command !== undefined) return stdioConfig(options.command);
  if (!prompter) {
    throw missingFlagError(
      '--config <path>, --url <url> or --command <command>',
      'the MCP server'
    );
  }

  const known = (await listKnownServers()).filter((server) => server.hasTokens);
  if (known.length > 0) {
    const choice = await prompter.choose('Select MCP server:', [
      ...known.map((server) => ({ label: server.url, value: server.url })),
      { label: 'Other (configure manually)', value: '__other__' },
    ]);
    if (choice !== '__other__') return httpConfig(choice);
  }
  const transport = await prompter.choose('Select MCP transport type:', [
    { label: 'stdio (local server process)', value: 'stdio' as const },
    { label: 'http (remote server)', value: 'http' as const },
  ]);
  return transport === 'stdio'
    ? stdioConfig(await prompter.text('Server command', 'node server.js'))
    : httpConfig(
        await prompter.text('Server URL', 'http://localhost:3000/mcp')
      );
}

function httpConfig(serverUrl: string): MCPConfig {
  return validateMCPConfig({
    transport: 'http',
    serverUrl,
    capabilities: ROOTS,
  });
}

function stdioConfig(commandLine: string): MCPConfig {
  const [command, ...args] = splitCommandLine(commandLine);
  return validateMCPConfig({
    transport: 'stdio',
    command,
    args,
    capabilities: ROOTS,
  });
}

async function listTools(client: Client, config: MCPConfig): Promise<Tool[]> {
  try {
    return (await client.listTools()).tools ?? [];
  } catch (error) {
    throw connectionError(error, config);
  }
}

function connectionError(error: unknown, config: MCPConfig): Error {
  if (isAuthError(error)) return new AuthRequiredError(config);
  return new Error(
    `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
  );
}

async function connect(config: MCPConfig): Promise<Client> {
  let withAuth = config;
  if (isHttpConfig(config)) {
    // A stored token, refreshed if it has expired. Without one, connect
    // anyway: the server may not need auth.
    const oauth = new CLIOAuthClient({ mcpServerUrl: config.serverUrl });
    const stored = await oauth.tryGetAccessToken();
    if (stored) {
      withAuth = { ...config, auth: { accessToken: stored.accessToken } };
    }
  }
  try {
    return await createMCPClientForConfig(withAuth);
  } catch (error) {
    throw connectionError(error, config);
  }
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('401') ||
    message.includes('Authorization') ||
    message.includes('Unauthorized') ||
    message.includes('authentication required')
  );
}

/**
 * The spec to add tests to, or null to write a new one. A file `mst
 * generate` didn't write can't be added to.
 */
async function specToAppend(
  outputPath: string,
  prompter: Prompter | null
): Promise<string | null> {
  try {
    await stat(outputPath);
  } catch {
    return null;
  }
  if (
    prompter &&
    !(await prompter.confirm(
      `Spec file exists at ${outputPath}. Add tests to it?`,
      true
    ))
  ) {
    return null;
  }
  const content = await readFile(outputPath, 'utf-8');
  if (!canAppendToolChecks(content)) {
    throw new Error(
      `${outputPath} wasn't written by mst generate, so it can't add tests to it. Choose a new --output file.`
    );
  }
  return content;
}

/** The titles of the tests already in a generated spec. */
function testTitles(source: string): string[] {
  return [...source.matchAll(/^\s*test\(("(?:[^"\\]|\\.)*")/gm)].flatMap(
    (match) => {
      try {
        return [JSON.parse(match[1]!) as string];
      } catch {
        return [];
      }
    }
  );
}

/** `<tool>-<n>`, with the first `n` no test in `titles` has. */
function defaultTitle(toolName: string, titles: Set<string>): string {
  for (let n = 1; ; n++) {
    const title = `${toolName}-${n}`;
    if (!titles.has(title)) return title;
  }
}

/** Calls the tool. A thrown error or an `isError` result records no check. */
async function callTool(
  client: Client,
  tool: Tool,
  args: Record<string, unknown>
): Promise<
  | { ok: true; response: unknown; result: unknown }
  | { ok: false; message: string }
> {
  try {
    const result = await callToolNormalized(client, {
      name: tool.name,
      arguments: args,
    });
    const response = result.structuredContent ?? result.content;
    if (result.isError) {
      return {
        ok: false,
        message: `${tool.name} returned an error, so there is no response to test:\n${jsonPreview(response, 10)}`,
      };
    }
    return { ok: true, response, result };
  } catch (error) {
    return {
      ok: false,
      message: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** `--args` as an object. */
function parseArgsFlag(value: string | undefined): Record<string, unknown> {
  let args: unknown;
  try {
    args = JSON.parse(value ?? '{}');
  } catch (error) {
    throw new Error(
      `--args isn't JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('--args must be a JSON object.');
  }
  return args as Record<string, unknown>;
}

/** One check from `--tool` and the other flags, keeping every suggestion. */
async function recordFromFlags(
  client: Client,
  tools: Tool[],
  options: GenerateOptions,
  args: Record<string, unknown>,
  titles: Set<string>
): Promise<ToolCheck> {
  const tool = tools.find((candidate) => candidate.name === options.tool);
  if (!tool) {
    throw new Error(
      `The server has no tool "${options.tool}". Its tools: ${tools.map((t) => t.name).join(', ') || 'none'}.`
    );
  }
  const id = options.name ?? defaultTitle(tool.name, titles);
  if (titles.has(id)) {
    throw new Error(
      `The spec already has a test named "${id}". Pass another --name.`
    );
  }

  print(`Calling ${tool.name}...`);
  const called = await callTool(client, tool, args);
  if (!called.ok) throw new Error(called.message);
  const suggestions = suggestAssertions(called.response, tool);
  const check: ToolCheck = {
    id,
    toolName: tool.name,
    args,
    ...(options.description ? { description: options.description } : {}),
  };
  if (options.snapshot) {
    check.snapshot = true;
  } else {
    if (suggestions.textContains.length > 0) {
      check.containsText = suggestions.textContains;
    }
    if (suggestions.regex.length > 0) check.matchesPattern = suggestions.regex;
    if (options.exact) check.response = called.result;
  }
  return check;
}

interface Recording {
  checks: ToolCheck[];
  titles: Set<string>;
}

/** Asks for tools, arguments and assertions until the user stops. */
async function recordInteractively(
  client: Client,
  tools: Tool[],
  options: GenerateOptions,
  prompter: Prompter,
  recording: Recording
): Promise<void> {
  if (tools.length === 0) return;
  for (;;) {
    print('');
    print('--- New Test Case ---');
    const toolName = await prompter.choose(
      'Select tool to test:',
      tools.map((tool) => ({ label: tool.name, value: tool.name }))
    );
    const tool = tools.find((candidate) => candidate.name === toolName)!;
    const args = await askArguments(prompter, tool);

    print(`Calling ${tool.name}...`);
    const called = await untilCancelled(callTool(client, tool, args), prompter);
    if (called.ok) {
      print(status('success', 'Tool called successfully'));
      print('Response preview:');
      print(jsonPreview(called.response, 10));
      const check = await askCheck(
        prompter,
        tool,
        args,
        called,
        options,
        recording
      );
      recording.checks.push(check);
      recording.titles.add(check.id);
      print(status('success', `Added test "${check.id}"`));
    } else {
      printError(called.message);
    }
    print(`Total tests: ${recording.checks.length}`);
    if (!(await prompter.confirm('Add another test?', true))) return;
  }
}

/** A test title no test in the spec has yet. */
async function askTitle(
  prompter: Prompter,
  toolName: string,
  titles: Set<string>
): Promise<string> {
  for (;;) {
    const title = await prompter.text(
      'Test name',
      defaultTitle(toolName, titles)
    );
    if (!titles.has(title)) return title;
    print(`The spec already has a test named "${title}".`);
  }
}

async function askCheck(
  prompter: Prompter,
  tool: Tool,
  args: Record<string, unknown>,
  called: { response: unknown; result: unknown },
  options: GenerateOptions,
  recording: Recording
): Promise<ToolCheck> {
  const id = await askTitle(prompter, tool.name, recording.titles);
  const description = await prompter.text(
    'Description (optional, press Enter to skip)'
  );
  const check: ToolCheck = {
    id,
    toolName: tool.name,
    args,
    ...(description ? { description } : {}),
  };
  if (options.snapshot) {
    check.snapshot = true;
    return check;
  }

  const suggestions = suggestAssertions(called.response, tool);
  if (
    suggestions.textContains.length > 0 &&
    (await prompter.confirm(
      `Add text contains assertions? (${suggestions.textContains.map((t) => `"${t}"`).join(', ')})`,
      true
    ))
  ) {
    check.containsText = suggestions.textContains;
  }
  if (
    suggestions.regex.length > 0 &&
    (await prompter.confirm(
      `Add regex assertions? (${suggestions.regex.map((r) => `/${r}/`).join(', ')})`,
      true
    ))
  ) {
    check.matchesPattern = suggestions.regex;
  }
  if (await prompter.confirm('Add exact match assertion?', true)) {
    check.response = called.result;
  }
  if (await prompter.confirm('Use Playwright snapshot testing?', true)) {
    check.snapshot = true;
  }
  return check;
}

interface SchemaProperty {
  name: string;
  type: string;
  description?: string;
  required: boolean;
}

function schemaProperties(tool: Tool): SchemaProperty[] {
  const schema = tool.inputSchema as
    | {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      }
    | undefined;
  const required = schema?.required ?? [];
  return Object.entries(schema?.properties ?? {}).map(([name, prop]) => ({
    name,
    type: prop.type ?? 'string',
    description: prop.description,
    required: required.includes(name),
  }));
}

/** The call's arguments: one prompt per schema property, or raw JSON. */
async function askArguments(
  prompter: Prompter,
  tool: Tool
): Promise<Record<string, unknown>> {
  const properties = schemaProperties(tool);
  if (properties.length === 0) {
    if (tool.description) print(tool.description);
    for (;;) {
      const answer = await prompter.text('Tool arguments (JSON)', '{}');
      try {
        const parsed: unknown = JSON.parse(answer);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ask again.
      }
      print('Enter a JSON object, such as {"query": "x"}.');
    }
  }

  const args: Record<string, unknown> = {};
  for (const [index, prop] of properties.entries()) {
    print(`Field ${index + 1} of ${properties.length}`);
    if (prop.description) print(prop.description);
    const label = `${prop.name} (${prop.type})${prop.required ? '*' : ''}`;
    let value = await prompter.text(label);
    while (prop.required && value === '') {
      value = await prompter.text(label);
    }
    const parsed = parseArgument(prop.type, value);
    if (parsed !== undefined) args[prop.name] = parsed;
  }
  return args;
}

/** A typed value from a field's answer; undefined skips an empty field. */
function parseArgument(type: string, value: string): unknown {
  if (value === '') return undefined;
  switch (type) {
    case 'number':
    case 'integer':
      return Number(value);
    case 'boolean':
      return value.toLowerCase() === 'true';
    case 'array':
    case 'object':
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

function printDone(outputPath: string, checks: ToolCheck[]): void {
  print('');
  print(status('success', 'Spec generation complete!'));
  print(`Tests added: ${checks.length}`);
  print(`Output: ${outputPath}`);
  print('');
  print('Next steps:');
  print(`  npx playwright test ${outputPath}`);
  if (checks.some((check) => check.snapshot)) {
    print('');
    print('Snapshot testing:');
    print('  First run will capture snapshots');
    print('  Update: npx playwright test --update-snapshots');
  }
}

function printAuthRequired(config: MCPConfig): void {
  printError('Authentication required');
  if (isHttpConfig(config)) {
    process.stderr.write(
      `This server requires OAuth authentication.\nRun: mst login ${config.serverUrl}\nThen retry: mst generate\n`
    );
  } else {
    process.stderr.write(
      "Note: stdio servers typically don't require OAuth authentication.\n"
    );
  }
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${status('error', message)}\n`);
}
