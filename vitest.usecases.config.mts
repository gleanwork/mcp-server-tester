import { defineConfig } from 'vitest/config';

// The use-case suite runs the built CLI (`npm run build` first). It is kept
// out of `npm test` so unit tests don't depend on dist/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/usecases/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
