import {
  errorMessage,
  isFatalControlError,
  isRecord,
  requiresQuarantine,
} from './deadline.js';
import type {
  CoworkControl,
  CoworkControlContext,
  CoworkControlState,
} from './types.js';
import { CoworkControlError, isCoworkControlError } from './workflow.js';

const BUNDLE_ID = 'com.anthropic.claudefordesktop';

/**
 * Single-operation native clipboard seam. The implementation must replace the draft and
 * restore every original clipboard format before resolving, including on failure.
 * A timeout or uncertain restoration/delivery MUST throw CoworkControlError with
 * { quarantine: true }. A fatal refusal alone does not quarantine the runtime.
 * Use { fatal: false } only when restoration and a safe fallback are confirmed.
 * The default bridge uses the qualified runtime's paste_text operation.
 */
export type CoworkTransactionalPaste = (
  input: CoworkControlContext & { text: string }
) => Promise<void>;

/** Stock Cua 0.28 needs AXURL and transactional-paste patches for this adapter. */
export function createCuaCoworkControl(
  context: CoworkControlContext,
  options: { pasteText?: CoworkTransactionalPaste } = {}
): CoworkControl {
  const { pid, windowId } = context;
  async function command(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      const data = await context.call(name, args);
      if (
        data.refusal ||
        data.status === 'refused' ||
        data.status === 'unsupported'
      ) {
        throw new CoworkControlError(`Cua ${name} refused`);
      }
      return data;
    } catch (error) {
      if (isFatalControlError(error) || isCoworkControlError(error)) {
        throw new CoworkControlError(`Cua ${name} failed`, {
          fatal: isFatalControlError(error),
          quarantine: requiresQuarantine(error),
        });
      }
      if (/permission|denied|not.allowed|refus/i.test(errorMessage(error))) {
        throw new CoworkControlError(`Cua ${name} denied`);
      }
      throw error;
    }
  }
  async function elements(): Promise<Record<string, unknown>[]> {
    const raw = await command('get_window_state', {
      pid,
      window_id: windowId,
      include_screenshot: false,
      max_elements: 2000,
    });
    if (!Array.isArray(raw.elements) || !raw.elements.every(isRecord))
      throw new Error('unverified accessibility state');
    return raw.elements;
  }
  async function state(): Promise<CoworkControlState> {
    const all = await elements();
    const pages = all.filter((e) => e.role === 'AXWebArea');
    if (pages.length && pages.every((page) => typeof page.url !== 'string')) {
      throw new CoworkControlError(
        'backend-capability: Cua requires an AXURL patch; cannot verify fresh-task route'
      );
    }
    const page = pages
      .filter(
        (p) =>
          typeof p.url === 'string' &&
          /^(?:https?:\/\/)?claude\.ai\//i.test(p.url)
      )
      .sort(
        (a, b) =>
          numeric(a.depth) - numeric(b.depth) ||
          numeric(a.element_index) - numeric(b.element_index)
      )[0];
    const composer = all.find((e) => e.role === 'AXTextArea');
    return {
      pageUrl: typeof page?.url === 'string' ? page.url : undefined,
      composer: composer
        ? {
            value:
              typeof composer.value === 'string' ? composer.value : undefined,
          }
        : undefined,
      automaticallyApprove: all.some(
        (e) =>
          (e.role === 'AXPopUpButton' || e.role === 'AXButton') &&
          [e.label, e.value].some((value) =>
            /^Automatically approve(?:,|$)/i.test(string(value).trim())
          )
      ),
    };
  }
  function target(element: Record<string, unknown>): Record<string, unknown> {
    if (typeof element.element_token !== 'string' || !element.element_token)
      throw new Error('missing snapshot-bound element token');
    return { pid, window_id: windowId, element_token: element.element_token };
  }
  return {
    async openUrl(url) {
      if (url !== 'claude://cowork/new')
        throw new Error('unsupported Cowork deep link');
      const launched = await command('launch_app', {
        bundle_id: BUNDLE_ID,
        urls: [url],
      });
      if (launched.pid !== pid)
        throw new CoworkControlError(
          'deep link did not target the owned Claude process'
        );
    },
    observe: state,
    async paste(text) {
      const pasteText = options.pasteText ?? nativeTransactionalPaste;
      const front = await command('bring_to_front', {
        pid,
        window_id: windowId,
      });
      // Exact WindowServer/AX proof is authoritative. NSWorkspace active can lag.
      if (
        front.activated !== true ||
        front.pid !== pid ||
        front.window_id !== windowId ||
        !isRecord(front.exact_window_effect) ||
        front.exact_window_effect.verified !== true
      ) {
        throw new CoworkControlError(
          'Claude exact window did not become frontmost'
        );
      }
      try {
        await pasteText({ pid, windowId, call: command, text });
      } catch (error) {
        const known = isCoworkControlError(error) || isFatalControlError(error);
        const quarantine = !known || requiresQuarantine(error);
        // Even typed errors may contain clipboard data. Preserve only safety flags.
        throw new CoworkControlError(
          quarantine
            ? 'transactional paste failed; clipboard restoration or delivery is uncertain'
            : 'transactional paste failed',
          { fatal: isFatalControlError(error), quarantine }
        );
      }
    },
    async setValue(text) {
      const composer = (await elements()).find((e) => e.role === 'AXTextArea');
      if (!composer) throw new Error('composer unavailable');
      if (composer.in_web_content !== false)
        throw new Error(
          'backend-capability: Cua set_value cannot verify Cowork web-content input delivery'
        );
      const result = await command('set_value', {
        ...target(composer),
        value: text,
      });
      if (result.effect !== 'confirmed')
        throw new Error(
          'backend-capability: Cua set_value did not verify input delivery; refusing submission'
        );
    },
    async pressReturn() {
      await command('press_key', {
        pid,
        window_id: windowId,
        key: 'return',
        delivery_mode: 'foreground',
      });
    },
    async clickSend() {
      const send = (await elements()).find(
        (e) =>
          e.role === 'AXButton' &&
          /^(Send message|Send|Submit|Start task)(?:,|$)/i.test(string(e.label))
      );
      if (!send) throw new Error('send control unavailable');
      await command('click', target(send));
    },
  };
}

async function nativeTransactionalPaste(
  input: CoworkControlContext & { text: string }
): Promise<void> {
  const result = await input.call('paste_text', {
    pid: input.pid,
    window_id: input.windowId,
    text: input.text,
  });
  if (result.clipboard_restored !== true) {
    throw new CoworkControlError(
      'transactional paste did not confirm clipboard restoration',
      { quarantine: true }
    );
  }
  if (result.effect !== 'unverifiable') {
    throw new CoworkControlError(
      'transactional paste was refused before input'
    );
  }
  // Keyboard dispatch is not renderer proof. The workflow performs fresh
  // composer read-back and requires matching native evidence before success.
}

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
