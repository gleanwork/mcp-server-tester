import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

describe('the desktop drivers (scripts/*.py)', () => {
  it.skipIf(!python)(
    'pass their own unit tests (scripts/test_*.py)',
    () => {
      const result = spawnSync(
        'python3',
        ['-m', 'unittest', 'discover', '-p', 'test_*.py'],
        { cwd: scripts, encoding: 'utf8' }
      );
      expect(result.stderr).toMatch(/\nOK\b/);
      expect(result.status).toBe(0);
    },
    120_000
  );
});
