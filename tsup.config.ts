import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

/**
 * Optional judge SDKs, loaded with import() only when a judge runs. They are
 * never bundled, and a build must not fail because they aren't installed.
 */
const OPTIONAL_JUDGE_SDKS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@anthropic-ai/vertex-sdk',
  '@google/generative-ai',
  'openai',
];

/**
 * The CLI's terminal UI: Ink, the React it renders with, and everything that
 * loads React. Bundled into the CLI so it never loads the host project's React.
 * Left external, Ink is hoisted to the project's node_modules and resolves the
 * project's `react`; a React 19 project then crashes Ink's React 18 renderer on
 * startup (#424).
 */
const CLI_UI_BUNDLED = [
  'ink',
  'ink-spinner',
  '@inkjs/ui',
  'react',
  'react-reconciler',
  'scheduler',
];

/**
 * Ink connects to React DevTools only when DEV=true, from a module it loads
 * with import(). Bundled into one file, that module's static import of
 * `react-devtools-core` (an optional peer, not installed) would run on every
 * start, so the CLI build gets a no-op in its place.
 */
const noReactDevtools: Plugin = {
  name: 'no-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'no-react-devtools',
    }));
    build.onLoad({ filter: /.*/, namespace: 'no-react-devtools' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

const LIBRARY_EXTERNAL = [
  '@ai-sdk/google',
  '@ai-sdk/mistral',
  '@ai-sdk/azure',
  '@ai-sdk/deepseek',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/xai',
  '@google-cloud/storage',
  ...OPTIONAL_JUDGE_SDKS,
];

export default defineConfig([
  // Library build (ESM). The root and public subpaths share chunks, so registries and
  // classes are one instance whichever subpath a caller imports them from.
  {
    entry: {
      index: 'src/index.ts',
      'types/index': 'src/types/index.ts',
      evals: 'src/entries/evals.ts',
      auth: 'src/entries/auth.ts',
      'experimental/clients': 'src/entries/experimentalClients.ts',
    },
    format: ['esm'],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    outDir: 'dist',
    tsconfig: './tsconfig.build.json',
    // shims: false - main library doesn't use __dirname/__filename
    external: LIBRARY_EXTERNAL,
  },
  // Library build (CommonJS): the root and types only. The subpaths are ESM.
  {
    entry: {
      index: 'src/index.ts',
      'types/index': 'src/types/index.ts',
    },
    format: ['cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: false,
    outDir: 'dist',
    tsconfig: './tsconfig.build.json',
    external: LIBRARY_EXTERNAL,
  },
  // CLI build
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    treeshake: true,
    minify: false,
    outDir: 'dist/cli',
    tsconfig: './tsconfig.build.json',
    shims: true,
    noExternal: CLI_UI_BUNDLED,
    esbuildPlugins: [noReactDevtools],
    external: ['@google-cloud/storage', ...OPTIONAL_JUDGE_SDKS],
    banner: {
      // Ink's CommonJS dependencies (signal-exit, ws), bundled with it, call
      // require(), which an ES module doesn't have.
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __mstCreateRequire } from 'node:module';",
        'const require = __mstCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  },
  // Dry-run proxy: a small stdio entry point a client launches once per
  // server, so it doesn't load the whole CLI.
  {
    entry: { dryRun: 'src/proxy/dryRunProxyMain.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    treeshake: true,
    minify: false,
    outDir: 'dist/proxy',
    tsconfig: './tsconfig.build.json',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Reporter build
  {
    entry: ['src/reporters/mcpReporter.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: false,
    outDir: 'dist/reporters',
    tsconfig: './tsconfig.build.json',
    external: OPTIONAL_JUDGE_SDKS,
    shims: true, // Enable shims for __dirname/__filename in ESM
  },
  // Fixtures build
  {
    entry: ['src/fixtures/mcp.ts', 'src/fixtures/mcpAuth.ts'],
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    minify: false,
    outDir: 'dist/fixtures',
    tsconfig: './tsconfig.build.json',
    external: OPTIONAL_JUDGE_SDKS,
  },
]);
