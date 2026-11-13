/**
 * The Linux Cowork image's readiness check (docker/cowork-linux/bin/desktop-ready):
 * waits until Claude Desktop shows Cowork's prompt, over AT-SPI, with Cowork's
 * VM running.
 *
 * On a profile's first launch in gateway mode, Claude shows one screen, "Your
 * organization has set up Claude to run through a custom inference gateway",
 * with a Continue button. This is the image's own first-run step, not part of
 * a case: MST's driver never clicks through onboarding.
 *
 * Cowork starts its VM for the first task after a launch, and gives the guest
 * 60 s to connect. Under nested virtualization (a Mac's Docker VM) the guest
 * takes longer, so that task fails. After a profile's first failure Claude
 * stops the VM and reinstalls it, unless the profile is marked as having
 * reinstalled already (desktop-session marks it when the image seeded the
 * bundle); after a later one it lets the VM finish booting. Unless
 * MST_COWORK_WARM_VM=0, this starts one-line warm-up tasks until a VM startup
 * completes, then goes back to a new task, so a case's task finds the VM
 * running.
 *
 * The guest connecting ("guest ready") isn't enough: Cowork then installs its
 * SDK in the guest, with 30 s to do it, and under nested virtualization that
 * can take longer. The startup then fails ("installSdk timed out") with the VM
 * still connected, and a task started then has no shell. So a startup counts
 * only once it completes (Cowork starts its keepalive), after the last
 * failure; another warm-up task retries the install on the connected VM. A
 * task that finds the VM connected installs the SDK too, and its failure
 * ("Post-connect setup failed") is retried the same way.
 *
 * A startup logs every few seconds while it boots. One that stops logging
 * without a failure has stalled: after the stall time of silence, another
 * warm-up task starts it again rather than waiting out the deadline. If no
 * startup completes, the error names the VM log's last line, where it stopped.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { percentEncodeUtf8 } from '../urlComponent.js';
import type { LinuxUiNode } from './linuxUi.js';

const GATEWAY_NOTICE = 'custom inference gateway';
const PROMPT = 'write your prompt';
/** What Cowork logs once a VM startup has completed: the SDK installed and the keepalive started. */
const STARTUP_COMPLETE = ['[Keepalive] Starting', 'sdk_install completed'];
/**
 * A startup that failed, and a task that found the VM connected but couldn't
 * install the SDK in it ("already-connected fast path").
 */
const STARTUP_FAILED = ['Startup failed', 'Post-connect setup failed'];

/** The one desktop the check reads and acts on. Every call is bounded and may fail. */
export interface ReadyDesktop {
  /** The Claude application's nodes, or undefined while it isn't on the bus. */
  nodes(): Promise<readonly LinuxUiNode[] | undefined>;
  /** One DoAction on a node from the latest nodes(). True when the app accepted it. */
  press(node: LinuxUiNode): Promise<boolean>;
  /** Hand a claude:// URL to the opener. Failures are ignored, as a missing task shows. */
  open(url: string): Promise<void>;
  /** Cowork's VM log from a byte offset; empty while it doesn't exist. */
  vmLog(offset: number): Promise<string>;
  vmLogSize(): Promise<number>;
  log(line: string): void;
}

export interface ReadyOptions {
  promptDeadlineS: number;
  warmVm: boolean;
  warmDeadlineS: number;
  stallS: number;
  /** One poll interval, injected for tests. */
  tick?: (ms: number) => Promise<void>;
  now?: () => number;
}

function text(node: LinuxUiNode): string {
  return node.name.trim();
}

function button(
  nodes: readonly LinuxUiNode[],
  name: string
): LinuxUiNode | undefined {
  return nodes.find((node) => node.role === 'button' && text(node) === name);
}

/** The last non-blank line of a log, at most 200 characters. */
export function lastLine(log: string): string {
  const lines = log.split(/\r?\n/).filter((line) => line.trim());
  return lines.length ? lines.at(-1)!.trim().slice(0, 200) : '';
}

/** A startup completed after the last one that failed. */
export function vmReady(log: string): boolean {
  const failed = Math.max(
    ...STARTUP_FAILED.map((marker) => log.lastIndexOf(marker))
  );
  return STARTUP_COMPLETE.some((marker) => log.lastIndexOf(marker) > failed);
}

/**
 * Claude gave up on this start: once it's done, another task boots the VM
 * again (or finds it still booting).
 */
export function startGaveUp(seen: string): boolean {
  if (seen.includes('Post-connect setup failed')) return true;
  if (!seen.includes('Startup failed')) return false;
  return (
    seen.split('Startup failed').at(-1)!.includes('All files ready') ||
    seen.includes('Skipping auto-reinstall')
  );
}

/** Waits for Cowork's prompt and, unless turned off, a warm VM. Returns a problem or undefined. */
export async function desktopReady(
  desktop: ReadyDesktop,
  options: ReadyOptions
): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const tick = options.tick ?? ((ms: number) => delay(ms));

  /** Cowork's prompt is showing, after the gateway notice if there is one. */
  async function waitForPrompt(seconds: number): Promise<boolean> {
    const deadline = now() + seconds * 1000;
    let clicked = false;
    while (now() < deadline) {
      const nodes = await desktop.nodes().catch(() => undefined);
      if (nodes) {
        if (
          nodes.some(
            (node) =>
              node.role === 'entry' && text(node).toLowerCase().includes(PROMPT)
          )
        )
          return true;
        const notice = nodes.some((node) =>
          text(node).toLowerCase().includes(GATEWAY_NOTICE)
        );
        const target = button(nodes, 'Continue');
        if (notice && !clicked && target)
          clicked = await desktop.press(target).catch(() => false);
      }
      await tick(1000);
    }
    return false;
  }

  async function startTask(prompt: string): Promise<boolean> {
    await desktop.open(`claude://claude.ai/new?q=${percentEncodeUtf8(prompt)}`);
    const deadline = now() + 15_000;
    while (now() < deadline) {
      const nodes = await desktop.nodes().catch(() => undefined);
      const target = nodes ? button(nodes, 'Start task') : undefined;
      if (target && (await desktop.press(target).catch(() => false)))
        return true;
      await tick(1000);
    }
    return false;
  }

  async function warmVm(): Promise<string | undefined> {
    const deadline = now() + options.warmDeadlineS * 1000;
    // The guest can become ready between two warm-up tasks, so readiness is
    // read from everything logged since the warm-up began.
    const began = await desktop.vmLogSize();
    while (now() < deadline) {
      const offset = await desktop.vmLogSize();
      if (!(await startTask('Reply with OK.')))
        return "the warm-up task couldn't be started";
      let size = offset;
      let grew = now();
      while (now() < deadline) {
        const seen = await desktop.vmLog(offset);
        if (vmReady(await desktop.vmLog(began))) {
          await desktop.open('claude://claude.ai/new');
          return (await waitForPrompt(30))
            ? undefined
            : 'no new task after the warm-up';
        }
        if (startGaveUp(seen)) {
          await tick(3000);
          break;
        }
        const current = await desktop.vmLogSize();
        if (current !== size) {
          size = current;
          grew = now();
        } else if (now() - grew > options.stallS * 1000) {
          desktop.log(
            `Cowork's VM log was silent for ${options.stallS} s; starting another warm-up task`
          );
          break;
        }
        await tick(2000);
      }
    }
    const last = lastLine(await desktop.vmLog(began));
    return `Cowork's VM wasn't ready within ${options.warmDeadlineS} s${last ? ` (its log last said: ${last})` : ' (its log said nothing)'}`;
  }

  if (!(await waitForPrompt(options.promptDeadlineS)))
    return `Cowork's prompt didn't appear within ${options.promptDeadlineS} s`;
  return options.warmVm ? warmVm() : undefined;
}
