import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasLLMCredential, resolveLLMEndpoint } from './endpoint.js';

const GATEWAY = 'https://gateway.example/anthropic';
const ANTHROPIC_PUBLIC = 'https://api.anthropic.com';
const OPENAI_PUBLIC = 'https://api.openai.com/v1';

/** A shell command that prints `token` and counts its runs in `counter`. */
function countingCommand(token: string, counter: string): string {
  return `node -e "require('fs').appendFileSync(process.argv[1], 'x'); process.stdout.write(process.argv[2] + '\\n')" "${counter}" "${token}"`;
}

function runs(counter: string): number {
  try {
    return readFileSync(counter, 'utf8').length;
  } catch {
    return 0;
  }
}

describe('resolveLLMEndpoint', () => {
  const dirs: string[] = [];
  function counterFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mst-llm-endpoint-'));
    dirs.push(dir);
    return join(dir, 'runs');
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it('uses the API key and the public API by default', async () => {
    await expect(
      resolveLLMEndpoint('anthropic', { env: { ANTHROPIC_API_KEY: 'k' } })
    ).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
      apiKey: 'k',
    });
    await expect(
      resolveLLMEndpoint('openai', { env: { OPENAI_API_KEY: 'k' } })
    ).resolves.toEqual({
      baseURL: OPENAI_PUBLIC,
      overridden: false,
      apiKey: 'k',
    });
  });

  it('passes the base URL override through', async () => {
    await expect(
      resolveLLMEndpoint('openai', {
        env: { OPENAI_BASE_URL: 'https://gw/openai/v1', OPENAI_API_KEY: 'k' },
      })
    ).resolves.toEqual({
      baseURL: 'https://gw/openai/v1',
      overridden: true,
      apiKey: 'k',
    });
  });

  it('treats an empty base URL as unset, so no SDK falls back to process.env', async () => {
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: { ANTHROPIC_BASE_URL: '  ', ANTHROPIC_API_KEY: 'k' },
      })
    ).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
      apiKey: 'k',
    });
  });

  it('normalises the Anthropic base URL to the API root, accepting a trailing /v1', async () => {
    for (const configured of [
      GATEWAY,
      `${GATEWAY}/`,
      `${GATEWAY}/v1`,
      `${GATEWAY}/v1/`,
    ]) {
      await expect(
        resolveLLMEndpoint('anthropic', {
          env: { ANTHROPIC_BASE_URL: configured, ANTHROPIC_API_KEY: 'k' },
        })
      ).resolves.toEqual({ baseURL: GATEWAY, overridden: true, apiKey: 'k' });
    }
  });

  it('sends ANTHROPIC_AUTH_TOKEN as a bearer token, ahead of the API key', async () => {
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: {
          ANTHROPIC_BASE_URL: GATEWAY,
          ANTHROPIC_AUTH_TOKEN: 'bearer',
          ANTHROPIC_API_KEY: 'key',
        },
      })
    ).resolves.toEqual({
      baseURL: GATEWAY,
      overridden: true,
      authToken: 'bearer',
    });
  });

  it('never sends ANTHROPIC_AUTH_TOKEN to the public API', async () => {
    const env = { ANTHROPIC_AUTH_TOKEN: 'gateway-token' };
    expect(hasLLMCredential('anthropic', { env })).toBe(false);
    await expect(resolveLLMEndpoint('anthropic', { env })).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
    });
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: { ...env, ANTHROPIC_API_KEY: 'key' },
      })
    ).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
      apiKey: 'key',
    });
  });

  it('reads only the explicit apiKeyEnvVar when one is given', async () => {
    const env = {
      MY_KEY: 'mine',
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_AUTH_TOKEN: 'bearer',
    };
    await expect(
      resolveLLMEndpoint('anthropic', { env, apiKeyEnvVar: 'MY_KEY' })
    ).resolves.toEqual({
      baseURL: GATEWAY,
      overridden: true,
      apiKey: 'mine',
    });
    await expect(
      resolveLLMEndpoint('anthropic', { env, apiKeyEnvVar: 'MISSING' })
    ).resolves.toEqual({ baseURL: GATEWAY, overridden: true });
    expect(
      hasLLMCredential('anthropic', { env, apiKeyEnvVar: 'MISSING' })
    ).toBe(false);
  });

  it('ignores empty credential variables and trims the rest', async () => {
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'key\r\n' },
      })
    ).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
      apiKey: 'key',
    });
  });

  it('runs the auth command only when a base URL override is set', async () => {
    const counter = counterFile();
    const env = { MST_LLM_AUTH_COMMAND: countingCommand('tok', counter) };
    expect(hasLLMCredential('anthropic', { env })).toBe(false);
    await expect(resolveLLMEndpoint('anthropic', { env })).resolves.toEqual({
      baseURL: ANTHROPIC_PUBLIC,
      overridden: false,
    });
    expect(runs(counter)).toBe(0);
  });

  it('sends the command token as a bearer token for Anthropic and as the key for OpenAI', async () => {
    const counter = counterFile();
    const command = countingCommand('tok-a', counter);
    expect(
      hasLLMCredential('anthropic', {
        env: { ANTHROPIC_BASE_URL: GATEWAY, MST_LLM_AUTH_COMMAND: command },
      })
    ).toBe(true);
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: { ANTHROPIC_BASE_URL: GATEWAY, MST_LLM_AUTH_COMMAND: command },
      })
    ).resolves.toEqual({
      baseURL: GATEWAY,
      overridden: true,
      authToken: 'tok-a',
    });
    await expect(
      resolveLLMEndpoint('openai', {
        env: {
          OPENAI_BASE_URL: 'https://gw/v1',
          MST_LLM_AUTH_COMMAND: command,
        },
      })
    ).resolves.toEqual({
      baseURL: 'https://gw/v1',
      overridden: true,
      apiKey: 'tok-a',
    });
  });

  it('prefers the auth command over ambient credentials when a base URL override is set', async () => {
    const counter = counterFile();
    await expect(
      resolveLLMEndpoint('anthropic', {
        env: {
          ANTHROPIC_BASE_URL: GATEWAY,
          ANTHROPIC_API_KEY: 'personal-key',
          ANTHROPIC_AUTH_TOKEN: 'static-token',
          MST_LLM_AUTH_COMMAND: countingCommand('tok-precedence', counter),
        },
      })
    ).resolves.toEqual({
      baseURL: GATEWAY,
      overridden: true,
      authToken: 'tok-precedence',
    });
    expect(runs(counter)).toBe(1);
  });

  it('prefers an explicit apiKeyEnvVar over the auth command', async () => {
    const counter = counterFile();
    await expect(
      resolveLLMEndpoint('anthropic', {
        apiKeyEnvVar: 'MY_KEY',
        env: {
          MY_KEY: 'mine',
          ANTHROPIC_BASE_URL: GATEWAY,
          MST_LLM_AUTH_COMMAND: countingCommand('tok', counter),
        },
      })
    ).resolves.toEqual({ baseURL: GATEWAY, overridden: true, apiKey: 'mine' });
    expect(runs(counter)).toBe(0);
  });

  it('caches the command token for the TTL and shares one run between concurrent callers', async () => {
    const counter = counterFile();
    const env = {
      ANTHROPIC_BASE_URL: GATEWAY,
      MST_LLM_AUTH_COMMAND: countingCommand('tok-cache', counter),
      MST_LLM_AUTH_COMMAND_TTL_MS: '60000',
    };
    const first = await Promise.all([
      resolveLLMEndpoint('anthropic', { env }),
      resolveLLMEndpoint('anthropic', { env }),
      resolveLLMEndpoint('anthropic', { env }),
    ]);
    expect(first.map((endpoint) => endpoint.authToken)).toEqual([
      'tok-cache',
      'tok-cache',
      'tok-cache',
    ]);
    expect(runs(counter)).toBe(1);

    await resolveLLMEndpoint('anthropic', { env });
    expect(runs(counter)).toBe(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_001);
    await resolveLLMEndpoint('anthropic', { env });
    expect(runs(counter)).toBe(2);
  });

  it('keys the cached token by the environment the command ran in', async () => {
    const counter = counterFile();
    const base = {
      ANTHROPIC_BASE_URL: GATEWAY,
      MST_LLM_AUTH_COMMAND: countingCommand('tok-env', counter),
    };
    await resolveLLMEndpoint('anthropic', { env: { ...base, TENANT: 'a' } });
    await resolveLLMEndpoint('anthropic', { env: { ...base, TENANT: 'a' } });
    expect(runs(counter)).toBe(1);
    await resolveLLMEndpoint('anthropic', { env: { ...base, TENANT: 'b' } });
    expect(runs(counter)).toBe(2);
  });

  it('reports a failing command without its stdout or stderr', async () => {
    const env = {
      ANTHROPIC_BASE_URL: GATEWAY,
      MST_LLM_AUTH_COMMAND: `node -e "process.stdout.write('secret-token'); process.stderr.write('+ echo secret-token'); process.exit(3)"`,
    };
    const error = await resolveLLMEndpoint('anthropic', { env }).catch(
      (err: unknown) => err as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'MST_LLM_AUTH_COMMAND failed (exit 3). Run it in a terminal to see its output.'
    );
  });

  it('rejects a command that prints nothing, and retries it next time', async () => {
    const env = {
      ANTHROPIC_BASE_URL: GATEWAY,
      MST_LLM_AUTH_COMMAND: `node -e "process.stdout.write('  ')"`,
    };
    await expect(resolveLLMEndpoint('anthropic', { env })).rejects.toThrow(
      'MST_LLM_AUTH_COMMAND printed no token.'
    );
    await expect(resolveLLMEndpoint('anthropic', { env })).rejects.toThrow(
      'MST_LLM_AUTH_COMMAND printed no token.'
    );
  });

  it('rejects an invalid TTL when it resolves the token', async () => {
    const env = {
      ANTHROPIC_BASE_URL: GATEWAY,
      MST_LLM_AUTH_COMMAND: 'true',
      MST_LLM_AUTH_COMMAND_TTL_MS: 'soon',
    };
    // Asking whether a credential exists never throws.
    expect(hasLLMCredential('anthropic', { env })).toBe(true);
    await expect(resolveLLMEndpoint('anthropic', { env })).rejects.toThrow(
      'MST_LLM_AUTH_COMMAND_TTL_MS must be a non-negative integer'
    );
  });
});
