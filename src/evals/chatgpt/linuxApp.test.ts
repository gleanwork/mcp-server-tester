import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as InstalledApp from '../installedApp.js';

const installedDebApp = vi.hoisted(() =>
  vi.fn(async () => ({
    name: 'ChatGPT',
    version: '1.2026.300',
    source: 'installed' as const,
  }))
);
vi.mock('../installedApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InstalledApp>()),
  installedDebApp,
}));

const { chatgptLinux } = await import('./linux.js');

describe('the Linux ChatGPT app', () => {
  it('records the package the image installs', async () => {
    expect(await chatgptLinux.app({ leaseKey: 'linux' })).toMatchObject({
      version: '1.2026.300',
    });
    expect(installedDebApp).toHaveBeenCalledWith('chatgpt', 'ChatGPT');
    // The image installs, and reports, the same package.
    const dockerfile = readFileSync(
      new URL('../../../docker/chatgpt-linux/Dockerfile', import.meta.url),
      'utf8'
    );
    expect(dockerfile).toMatch(/dpkg-query .* chatgpt$/m);
  });
});
