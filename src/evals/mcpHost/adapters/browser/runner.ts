import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, BrowserType } from 'playwright';
import type {
  BrowserConfig,
  LLMToolCall,
  MCPHostSimulationResult,
} from '../../mcpHostTypes.js';

const DEFAULT_TIMEOUT = 120_000;

/**
 * The signature a browser script must export as its default export.
 */
type BrowserScriptFn = (
  page: Page,
  scenario: string
) => Promise<MCPHostSimulationResult>;

/**
 * Runs a browser host: launches Chromium, injects auth, executes
 * the user-provided script, and returns the simulation result.
 *
 * Playwright is dynamically imported so the framework doesn't
 * hard-depend on it at the package level — it's already a peer
 * dependency via @playwright/test.
 */
export async function runBrowserHost(
  browserConfig: BrowserConfig,
  scenario: string
): Promise<MCPHostSimulationResult> {
  const timeout = browserConfig.timeout ?? DEFAULT_TIMEOUT;

  // Dynamic import — playwright is an optional peer dependency. Keeping the
  // package name indirect prevents tsup from bundling Chromium's optional
  // bidi implementation into every tester installation.
  let chromium: BrowserType;
  try {
    const playwrightPackage = 'playwright';
    const pw = (await import(playwrightPackage)) as unknown as {
      chromium: BrowserType;
    };
    chromium = pw.chromium;
  } catch {
    return {
      success: false,
      toolCalls: [],
      error:
        'Browser host requires the "playwright" package. Install it with: npm install playwright',
    };
  }

  // Resolve and import the user's script
  const scriptPath = resolve(process.cwd(), browserConfig.script);
  let scriptFn: BrowserScriptFn;
  try {
    const scriptModule = (await import(
      pathToFileURL(scriptPath).href
    )) as Record<string, unknown>;
    scriptFn = scriptModule.default as BrowserScriptFn;
    if (typeof scriptFn !== 'function') {
      return {
        success: false,
        toolCalls: [],
        error: `Browser script "${browserConfig.script}" must export a default function. Got ${typeof scriptFn}.`,
      };
    }
  } catch (err) {
    return {
      success: false,
      toolCalls: [],
      error: `Failed to import browser script "${browserConfig.script}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const browser = await chromium.launch({
    headless: browserConfig.headless ?? true,
  });

  try {
    // Create context with optional storageState
    const contextOptions: Record<string, unknown> = {};
    if (browserConfig.storageState) {
      contextOptions.storageState = resolve(
        process.cwd(),
        browserConfig.storageState
      );
    }

    const context = await browser.newContext(contextOptions);

    // Inject extra cookies if provided
    if (browserConfig.cookies && browserConfig.cookies.length > 0) {
      await context.addCookies(browserConfig.cookies);
    }

    const page = await context.newPage();

    // Run the script with a timeout
    let result: MCPHostSimulationResult;
    try {
      result = await Promise.race([
        scriptFn(page, scenario),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Browser script timed out after ${timeout}ms. ` +
                    `Increase timeout via mcpHostConfig.browser.timeout.`
                )
              ),
            timeout
          )
        ),
      ]);
    } catch (err) {
      return {
        success: false,
        toolCalls: [],
        error: `Browser script failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Validate the result
    const validationError = validateSimulationResult(result);
    if (validationError) {
      return {
        success: false,
        toolCalls: [],
        error: `Browser script returned invalid result: ${validationError}`,
      };
    }

    return result;
  } finally {
    await browser.close();
  }
}

export function validateSimulationResult(result: unknown): string | null {
  if (result === null || typeof result !== 'object') {
    return `Expected object, got ${typeof result}`;
  }

  const obj = result as Record<string, unknown>;

  if (typeof obj.success !== 'boolean') {
    return `"success" must be a boolean, got ${typeof obj.success}`;
  }

  if (!Array.isArray(obj.toolCalls)) {
    return `"toolCalls" must be an array, got ${typeof obj.toolCalls}`;
  }

  for (let i = 0; i < obj.toolCalls.length; i++) {
    const tc = obj.toolCalls[i] as LLMToolCall;
    if (typeof tc.name !== 'string') {
      return `toolCalls[${i}].name must be a string, got ${typeof tc.name}`;
    }
    if (typeof tc.arguments !== 'object' || tc.arguments === null) {
      return `toolCalls[${i}].arguments must be an object, got ${typeof tc.arguments}`;
    }
  }

  return null;
}
