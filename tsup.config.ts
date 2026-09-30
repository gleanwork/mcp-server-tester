import { defineConfig } from 'tsup';

/**
 * Optional judge SDKs, loaded with import() only when a judge runs. They are
 * never bundled, and a build must not fail because they aren't installed.
 */
const OPTIONAL_JUDGE_SDKS = [
  '@anthropic-ai/sdk',
  '@anthropic-ai/vertex-sdk',
  '@google/generative-ai',
  'openai',
];

export default defineConfig([
  // Library build
  {
    entry: ['src/index.ts', 'src/types/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    outDir: 'dist',
    tsconfig: './tsconfig.build.json',
    // shims: false - main library doesn't use __dirname/__filename
    external: [
      '@ai-sdk/google',
      '@ai-sdk/mistral',
      '@ai-sdk/azure',
      '@ai-sdk/deepseek',
      '@openrouter/ai-sdk-provider',
      '@ai-sdk/xai',
      '@google-cloud/storage',
      ...OPTIONAL_JUDGE_SDKS,
    ],
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
    external: ['@google-cloud/storage', ...OPTIONAL_JUDGE_SDKS],
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
