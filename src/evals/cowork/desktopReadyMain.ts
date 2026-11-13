/** The Cowork image's desktop-ready command, on the image's Node. Exits 0 once Cowork is ready. */
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectLinuxUi } from './linuxAtspi.js';
import { desktopReady } from './desktopReady.js';
import type { LinuxUi } from './linuxUi.js';

const VM_LOG = join(homedir(), '.config/Claude-3p/logs/cowork_vm_node.log');
const OPEN_URL = process.env.MST_COWORK_URL_OPENER ?? '/opt/mst/bin/open-url';
/** One read of the desktop: connect, act, close. Claude can restart under the check. */
const CALL_MS = 10_000;

function seconds(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let ui: LinuxUi | undefined;

async function connected(): Promise<LinuxUi> {
  await ui?.close();
  ui = undefined;
  ui = await connectLinuxUi(process.env, Date.now() + CALL_MS);
  return ui;
}

const problem = await desktopReady(
  {
    async nodes() {
      return (await connected()).snapshot();
    },
    async press(node) {
      if (!ui) return false;
      try {
        await ui.activate(node);
        return true;
      } catch {
        return false;
      }
    },
    async open(url) {
      await new Promise<void>((resolve) => {
        execFile(OPEN_URL, [url], { timeout: 30_000, shell: false }, () =>
          resolve()
        );
      });
    },
    async vmLog(offset) {
      const file = await open(VM_LOG, 'r').catch(() => undefined);
      if (!file) return '';
      try {
        const { size } = await file.stat();
        const buffer = Buffer.alloc(Math.max(0, size - offset));
        await file.read(buffer, 0, buffer.length, offset);
        return buffer.toString('utf8');
      } finally {
        await file.close();
      }
    },
    async vmLogSize() {
      return (await stat(VM_LOG).catch(() => undefined))?.size ?? 0;
    },
    log(line) {
      process.stderr.write(`${line}\n`);
    },
  },
  {
    promptDeadlineS: 120,
    warmVm: process.env.MST_COWORK_WARM_VM !== '0',
    // Inside MST's limit for the restart command (MST_DESKTOP_RESTART_TIMEOUT_S,
    // 900 s in this image): a nested guest can take minutes to boot.
    warmDeadlineS: seconds('MST_COWORK_WARM_VM_TIMEOUT_S', 840),
    stallS: seconds('MST_COWORK_WARM_VM_STALL_S', 120),
  }
);
await ui?.close();
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
}
