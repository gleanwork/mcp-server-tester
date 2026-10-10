import { z } from 'zod';
import { compileSwiftHelper, type NativeHelper } from '../nativeHelper.js';
import { macCoworkControllerSource } from './macControllerSource.js';

const ERROR = 'Unable to control the Mac Cowork application safely.';
const StateSchema = z.object({
  running: z.boolean(),
  instances: z.number().int().min(0).max(1),
  workspaceApplicationCount: z.number().int().positive(),
  claudeBundleReadable: z.literal(true),
  runningAppPath: z.string().optional(),
});

/** Application lifecycle only: no MCP inventory or query interface. */
export interface MacCoworkController {
  state(): Promise<{ running: boolean; runningAppPath?: string }>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

const compiled = new Map<string, Promise<MacCoworkController>>();

function configuredAppPath(
  value = process.env.MST_COWORK_APP_PATH ?? '/Applications/Claude.app'
): string {
  if (
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  )
    throw new Error(ERROR);
  return value;
}

async function compile(appPath: string): Promise<MacCoworkController> {
  let helper: NativeHelper;
  try {
    helper = await compileSwiftHelper({
      name: 'cowork-native',
      source: macCoworkControllerSource(appPath),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`${ERROR} Native controller build failed (${code}).`);
  }
  // The lifecycle helper never launches with caller credentials.
  const invoke = async (
    action: 'state' | 'stop' | 'start'
  ): Promise<unknown> => {
    try {
      return await helper.run([action], {
        environment: 'minimal',
        timeoutMs: 30_000,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      throw new Error(`${ERROR} Native ${action} failed (${code}).`);
    }
  };
  return {
    async state() {
      try {
        const state = StateSchema.parse(await invoke('state'));
        if (state.running !== (state.instances === 1)) throw new Error();
        return {
          running: state.running,
          ...(state.runningAppPath
            ? { runningAppPath: configuredAppPath(state.runningAppPath) }
            : {}),
        };
      } catch (error) {
        throw new Error(
          `${ERROR} State check failed: ${error instanceof Error ? error.message : 'unknown'}`
        );
      }
    },
    async stop() {
      try {
        z.object({ stopped: z.literal(true) }).parse(await invoke('stop'));
      } catch {
        throw new Error(ERROR);
      }
    },
    async start() {
      try {
        z.object({ launched: z.literal(true) }).parse(await invoke('start'));
      } catch {
        throw new Error(ERROR);
      }
    },
  };
}

/** Small module seam for lifecycle tests; never invoke native tools off macOS. */
export async function getMacCoworkController(
  appPath?: string
): Promise<MacCoworkController> {
  if (process.platform !== 'darwin') throw new Error(ERROR);
  const path = configuredAppPath(appPath);
  let controller = compiled.get(path);
  if (!controller) {
    controller = compile(path).catch(() => {
      compiled.delete(path);
      throw new Error(ERROR);
    });
    compiled.set(path, controller);
  }
  return controller;
}
