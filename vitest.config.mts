import { defineConfig } from 'vitest/config';

// `npm run test:coverage` (scripts/test-coverage.ts) sets MST_COVERAGE. Coverage
// slows every test and the processes it starts, so tests that wait on a timer
// get more time there.
const COVERAGE = process.env.MST_COVERAGE === '1';

export default defineConfig({
  test: {
    ...(COVERAGE ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'tests/**/*.spec.ts',
      'src/**/*.integration.test.ts',
      // Runs the built CLI; see vitest.usecases.config.mts.
      'tests/usecases/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Files no test loads are reported too, with every line unrun.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'node_modules',
        'dist',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
      ],
    },
  },
});
