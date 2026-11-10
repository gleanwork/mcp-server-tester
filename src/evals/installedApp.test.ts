import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clientApp,
  installedDebVersion,
  macAppBundle,
} from './installedApp.js';

// It reads the bundle with macOS's plutil.
describe.skipIf(process.platform !== 'darwin')('macAppBundle', () => {
  it("reads an app bundle's name and version", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-app-'));
    try {
      const app = join(dir, 'ChatGPT.app');
      await mkdir(join(app, 'Contents'), { recursive: true });
      await writeFile(
        join(app, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ChatGPT</string>
<key>CFBundleShortVersionString</key><string>26.1103.41825</string>
<key>CFBundleVersion</key><string>999</string>
</dict></plist>\n`
      );
      expect(await macAppBundle(app)).toEqual({
        name: 'ChatGPT',
        version: '26.1103.41825',
        source: 'installed',
      });
      expect(await macAppBundle(join(dir, 'Missing.app'))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('installedDebVersion', () => {
  const status = [
    'Package: claude-desktop-beta',
    'Status: install ok installed',
    'Version: 9.9.9',
    '',
    'Package: claude-desktop',
    'Status: install ok installed',
    'Architecture: arm64',
    'Version: 2.31226.1',
    'Depends: libgtk-3-0',
    '',
    'Package: removed-app',
    'Status: deinstall ok config-files',
    'Version: 1.0',
    '',
  ].join('\n');

  it("reads an installed package's version from dpkg's status file", () => {
    expect(installedDebVersion(status, 'claude-desktop')).toBe('2.31226.1');
    // Removed, with only its config files left: not installed.
    expect(installedDebVersion(status, 'removed-app')).toBeUndefined();
    expect(installedDebVersion(status, 'missing')).toBeUndefined();
  });
});

describe('clientApp', () => {
  it('records a short name and version', () => {
    expect(clientApp('Claude Code', '2.1.4')).toEqual({
      name: 'Claude Code',
      version: '2.1.4',
      source: 'installed',
    });
    expect(clientApp('ChatGPT', '1.2026.31~beta+1', 'installed')).toEqual({
      name: 'ChatGPT',
      version: '1.2026.31~beta+1',
      source: 'installed',
    });
  });

  it('records nothing for a missing, long or multi-line value', () => {
    expect(clientApp('Codex CLI', undefined)).toBeUndefined();
    expect(clientApp('Codex CLI', 7)).toBeUndefined();
    expect(clientApp('Codex CLI', '')).toBeUndefined();
    expect(clientApp('Codex CLI', '1.0\nforged: yes')).toBeUndefined();
    expect(clientApp('x'.repeat(65), '1.0')).toBeUndefined();
  });
});
