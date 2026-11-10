import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as InstalledApp from './installedApp.js';

const installedDebApp = vi.hoisted(() =>
  vi.fn(async (_name: string, label: string) => ({
    name: label,
    version: '1.2026.300',
    source: 'installed' as const,
  }))
);
vi.mock('./installedApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InstalledApp>()),
  installedDebApp,
}));

const { chatgptLinux } = await import('./chatgpt/linux.js');
const { installedCoworkApp } = await import('./cowork/linux.js');

function dockerfile(image: string): string {
  return readFileSync(
    new URL(`../../docker/${image}/Dockerfile`, import.meta.url),
    'utf8'
  );
}

// Each Linux desktop client records the package its image installs.
describe('the Linux desktop apps', () => {
  it('ChatGPT reads the chatgpt package', async () => {
    expect(await chatgptLinux.app({ leaseKey: 'linux' })).toMatchObject({
      name: 'ChatGPT',
    });
    expect(installedDebApp).toHaveBeenLastCalledWith('chatgpt', 'ChatGPT');
    expect(dockerfile('chatgpt-linux')).toMatch(/dpkg-query .* chatgpt$/m);
  });

  it('Cowork reads the claude-desktop package', async () => {
    expect(await installedCoworkApp()).toMatchObject({ name: 'Claude' });
    expect(installedDebApp).toHaveBeenLastCalledWith(
      'claude-desktop',
      'Claude'
    );
    expect(dockerfile('cowork-linux')).toMatch(/"claude-desktop\$\{/);
  });
});
