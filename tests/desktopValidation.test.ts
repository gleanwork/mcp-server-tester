/**
 * ADR 0017: a desktop client's default changes to `agent-desktop` only with a
 * validation record. The table of defaults is `DESKTOP_DEFAULTS`; the records
 * are `docs/desktop-validation/<client>-<os>.md`, next to the guide.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_DEFAULTS } from '../src/evals/desktopDefaults.js';
import type {
  DesktopAutomation,
  DesktopOS,
} from '../src/evals/desktopUi/automation.js';

const RECORDS = join(import.meta.dirname, '..', 'docs', 'desktop-validation');
const OSES: DesktopOS[] = ['linux', 'darwin'];

/** The record's sections, which the guide lists. */
const REQUIRED_SECTIONS = [
  '## Versions',
  '## Parity',
  '## Recorded trees',
  '## Each operation, live',
  '## A paired run',
  '## Not checked',
];

describe('desktop validation records', () => {
  const records = readdirSync(RECORDS).filter((name) => name !== 'README.md');

  it('exist for every client and OS whose default is agent-desktop', () => {
    // Typed as the table's union: today no default is agent-desktop, and the
    // check is for the day one is.
    const defaults: Record<
      string,
      Record<DesktopOS, DesktopAutomation>
    > = DESKTOP_DEFAULTS;
    for (const [client, byOs] of Object.entries(defaults))
      for (const os of OSES)
        if (byOs[os] === 'agent-desktop')
          expect(
            records,
            `${client} on ${os} defaults to agent-desktop without docs/desktop-validation/${client}-${os}.md`
          ).toContain(`${client}-${os}.md`);
  });

  it('name a client and OS the table knows, and have every section of the guide', () => {
    for (const record of records) {
      const match = /^(.+)-(linux|darwin)\.md$/.exec(record);
      expect(match, `${record} is not <client>-<os>.md`).not.toBeNull();
      expect(Object.keys(DESKTOP_DEFAULTS)).toContain(match![1]);
      const text = readFileSync(join(RECORDS, record), 'utf8');
      for (const section of REQUIRED_SECTIONS)
        expect(text, `${record} has no "${section}" section`).toContain(
          section
        );
    }
  });

  it('are described by a guide that names the four checks', () => {
    const guide = readFileSync(join(RECORDS, 'README.md'), 'utf8');
    for (const section of REQUIRED_SECTIONS.slice(1))
      expect(guide).toContain(section.slice(3));
    expect(guide).toContain('mst desktop parity');
    expect(guide).toContain('mst desktop snapshot');
  });
});
