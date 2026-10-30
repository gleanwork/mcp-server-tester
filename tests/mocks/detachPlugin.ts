/**
 * A plugin for `--detach` tests (ADR 0007): `detach/env/remote`, whose
 * coordinator machine records what it is sent; `detach/result-store/memory`,
 * a store other machines could reach; and credential stores, one shared and
 * one not. What happened is kept on `globalThis.__detachTest`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Plugin } from '../../src/plugins/plugin.js';
import type { RunStore } from '../../src/evals/runStore.js';
import type { CredentialStore } from '../../src/auth/grants/types.js';

export interface DetachTestState {
  objects: Map<string, Uint8Array>;
  /** Files the coordinator machine was sent, by path under the bundle. */
  sent: Map<string, string>;
  remoteDir?: string;
  argv?: string[];
  stdin: string[];
  disposed: number;
  coordinatorOptions?: Record<string, unknown>;
  /** The eval's client, as the coordinator machine was told it. */
  coordinatorClient?: string;
  /** What the coordinator prints: `{"type":"started"}` unless set. */
  reply?: string;
}

const global = globalThis as unknown as { __detachTest?: DetachTestState };

export function detachTestState(): DetachTestState {
  return (global.__detachTest ??= {
    objects: new Map(),
    sent: new Map(),
    stdin: [],
    disposed: 0,
  });
}

function memoryStore(): RunStore {
  const { objects } = detachTestState();
  return {
    location: 'memory://detach',
    async put(key, body) {
      objects.set(
        key,
        typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
      );
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async list(prefix, options) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      if (!options?.shallow) return keys;
      return [
        ...new Set(
          keys.map((key) => {
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            return slash < 0 ? key : `${prefix}${rest.slice(0, slash + 1)}`;
          })
        ),
      ];
    },
  };
}

function credentialStore(): CredentialStore {
  return {
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
    withLock: (_key, fn) => fn(),
    describe: () => 'memory',
  };
}

async function readTree(dir: string, base = dir): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      for (const [key, value] of await readTree(full, base))
        files.set(key, value);
    else files.set(path.relative(base, full), await fs.readFile(full, 'utf8'));
  }
  return files;
}

async function* once(text: string): AsyncIterable<string> {
  yield text;
}

export default {
  meta: { name: 'detach-plugin', namespace: 'detach' },
  resultStores: {
    memory: {
      schema: z.object({ type: z.string() }).passthrough(),
      create: () => memoryStore(),
    },
  },
  connectors: {
    slack: { url: 'https://slack.example/mcp', auth: { type: 'oauth' } },
  },
  credentialStores: {
    shared: { shared: true, create: () => credentialStore() },
    local: { create: () => credentialStore() },
  },
  environments: {
    remote: {
      schema: z.object({ zone: z.string().optional() }).strict(),
      async open() {
        throw new Error('detach tests never open shards here');
      },
      async coordinator(options, context) {
        const state = detachTestState();
        state.coordinatorOptions = options;
        state.coordinatorClient = context.client;
        return {
          id: `coordinator-${context.id}`,
          workDir: '/opt/mst',
          mst: ['node', '/opt/mst/node_modules/.bin/mst'],
          finish: ['delete-me'],
          channel: {
            exec(argv, io) {
              state.argv = argv;
              return {
                stdout: (async function* () {
                  for await (const line of io.stdin) state.stdin.push(line);
                  yield state.reply ?? '{"type":"started","pid":42}\n';
                })(),
                stderr: once(''),
                exit: Promise.resolve(0),
              };
            },
            async put(localDir, remoteDir) {
              state.remoteDir = remoteDir;
              state.sent = await readTree(localDir);
            },
            async get() {},
          },
          async dispose() {
            state.disposed += 1;
          },
        };
      },
    },
  },
} satisfies Plugin;
