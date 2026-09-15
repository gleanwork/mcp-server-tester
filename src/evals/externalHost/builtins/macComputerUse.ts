import { createNativeMacComputerUseProvider } from './nativeMacComputerUse.js';
export { createNativeMacComputerUseProvider } from './nativeMacComputerUse.js';

export interface MacComputerUseApp {
  getAXStateAndScreenshot(options?: {
    disableDiffing?: boolean;
    emit?: boolean;
  }): Promise<{ state?: string; screenshot?: unknown }>;
  click(elementIndex: number): Promise<unknown>;
  setValue(elementIndex: number, value: string): Promise<unknown>;
  pressKey(key: string): Promise<unknown>;
}

export interface MacComputerUseRuntime {
  getApp(appName: string): Promise<MacComputerUseApp>;
}

export interface MacComputerUseProvider extends MacComputerUseRuntime {
  id: string;
  displayName?: string;
}

interface GlobalComputerUseHost {
  cua?: {
    getApp?: (appName: string) => Promise<unknown>;
  };
}

export interface MacComputerUseNode {
  index: number;
  depth: number;
  text: string;
  value?: string;
  url?: string;
}

export interface MacComputerUseObservation {
  text: string;
  nodes: MacComputerUseNode[];
  screenshot?: unknown;
}

const computerUseProviders = new Map<string, MacComputerUseProvider>();

const staleMarkers = [
  '-10005',
  'nowindowsavailable',
  'windownotfoundatposition',
  'no longer valid',
  'is not active',
  'is not defined',
  'screencapturekit',
  'the user changed',
  're-query the latest state',
  'axerror.invaliduielement',
];

export function registerMacComputerUseProvider(
  provider: MacComputerUseProvider
): () => void {
  if (!provider.id.trim()) {
    throw new Error('Computer Use provider id must be non-empty.');
  }
  if (typeof provider.getApp !== 'function') {
    throw new Error(
      `Computer Use provider ${provider.id} must implement getApp.`
    );
  }
  if (computerUseProviders.has(provider.id)) {
    throw new Error(
      `Computer Use provider is already registered: ${provider.id}`
    );
  }
  computerUseProviders.set(provider.id, provider);
  return () => {
    if (computerUseProviders.get(provider.id) === provider) {
      computerUseProviders.delete(provider.id);
    }
  };
}

export function listMacComputerUseProviders(): MacComputerUseProvider[] {
  return Array.from(computerUseProviders.values());
}

export async function loadMacComputerUseProvider(
  moduleSpecifier: string
): Promise<MacComputerUseProvider> {
  const module = (await import(moduleSpecifier)) as {
    default?: MacComputerUseProvider;
    provider?: MacComputerUseProvider;
    createProvider?: () =>
      | MacComputerUseProvider
      | Promise<MacComputerUseProvider>;
  };
  const provider =
    module.default ?? module.provider ?? (await module.createProvider?.());
  if (!provider) {
    throw new Error(
      `Computer Use plugin ${moduleSpecifier} must default-export a provider, export provider, or export createProvider.`
    );
  }
  registerMacComputerUseProvider(provider);
  return provider;
}

export function getMacComputerUseRuntime(
  providerId = 'global-cua'
): MacComputerUseRuntime {
  const provider = computerUseProviders.get(providerId);
  if (!provider) {
    const available =
      Array.from(computerUseProviders.keys()).join(', ') || 'none';
    throw new Error(
      `Computer Use provider not registered: ${providerId}. Available providers: ${available}`
    );
  }
  return provider;
}

export function createGlobalCuaComputerUseProvider(): MacComputerUseProvider {
  return {
    id: 'global-cua',
    displayName: 'Host-provided globalThis.cua',
    async getApp(appName) {
      const host = globalThis as typeof globalThis & GlobalComputerUseHost;
      if (typeof host.cua?.getApp !== 'function') {
        throw new Error(
          'Computer Use runtime unavailable: globalThis.cua.getApp is not initialized. Register a CUA provider or run MST inside a CUA-enabled host.'
        );
      }

      let rawApp: unknown;
      try {
        rawApp = await host.cua.getApp(appName);
      } catch (error) {
        throw new Error(
          `Computer Use could not acquire native app ${appName}: ${formatError(error)}`
        );
      }
      return validateMacComputerUseApp(appName, rawApp);
    },
  };
}

registerMacComputerUseProvider(createGlobalCuaComputerUseProvider());
registerMacComputerUseProvider(createNativeMacComputerUseProvider());

export function validateMacComputerUseApp(
  appName: string,
  app: unknown
): MacComputerUseApp {
  const missing = [
    'getAXStateAndScreenshot',
    'click',
    'setValue',
    'pressKey',
  ].filter(
    (method) =>
      typeof (app as Record<string, unknown> | null | undefined)?.[method] !==
      'function'
  );
  if (missing.length > 0) {
    throw new Error(
      `Computer Use native app ${appName} is missing: ${missing.join(', ')}`
    );
  }
  return app as MacComputerUseApp;
}

export async function observeMacComputerUseApp(
  app: MacComputerUseApp,
  options: { retries?: number } = {}
): Promise<MacComputerUseObservation> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await app.getAXStateAndScreenshot({
        disableDiffing: true,
        emit: false,
      });
      const text = String(result.state ?? '');
      return {
        text,
        nodes: parseMacComputerUseNodes(text),
        screenshot: result.screenshot,
      };
    } catch (error) {
      lastError = error;
      if (!isStaleMacComputerUseError(error) || attempt === retries) {
        throw error;
      }
    }
  }
  throw lastError;
}

export function parseMacComputerUseNodes(text: string): MacComputerUseNode[] {
  const nodes: MacComputerUseNode[] = [];
  const nodeLine = /^(\t*)(\d+)\s+(.*)$/;
  for (const line of String(text).split('\n')) {
    const match = nodeLine.exec(line);
    if (!match) continue;
    const rest = match[3] ?? '';
    nodes.push({
      index: Number(match[2] ?? 0),
      depth: (match[1] ?? '').length,
      text: rest,
      value: extractNodeField(rest, 'Value'),
      url: extractNodeField(rest, 'URL'),
    });
  }
  return nodes;
}

export function findMacComputerUseNode(
  nodes: MacComputerUseNode[],
  selector: string | RegExp
): MacComputerUseNode | undefined {
  return nodes.find((node) =>
    typeof selector === 'string'
      ? node.text.includes(selector)
      : selector.test(node.text)
  );
}

export function isStaleMacComputerUseError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return staleMarkers.some((marker) => message.includes(marker));
}

export async function waitForMacComputerUseText(
  app: MacComputerUseApp,
  predicate: (observation: MacComputerUseObservation) => boolean,
  options: { deadlineAt: number; intervalMs?: number }
): Promise<MacComputerUseObservation> {
  let lastObservation: MacComputerUseObservation = { text: '', nodes: [] };
  while (Date.now() < options.deadlineAt) {
    lastObservation = await observeMacComputerUseApp(app);
    if (predicate(lastObservation)) return lastObservation;
    await delay(
      Math.min(
        options.intervalMs ?? 250,
        Math.max(1, options.deadlineAt - Date.now())
      )
    );
  }
  throw new Error(
    `Computer Use timed out waiting for expected Claude UI state: ${lastObservation.text
      .replaceAll(/\s+/g, ' ')
      .slice(0, 500)}`
  );
}

export async function actOnMacComputerUseNode(
  app: MacComputerUseApp,
  selector: string | RegExp,
  action: (node: MacComputerUseNode) => Promise<unknown>,
  options: {
    retries?: number;
    verify?: (observation: MacComputerUseObservation) => boolean;
  } = {}
): Promise<MacComputerUseNode> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const observation = await observeMacComputerUseApp(app);
    const node = findMacComputerUseNode(observation.nodes, selector);
    if (!node) {
      lastError = new Error(
        `Computer Use could not find UI node matching ${String(selector)}`
      );
      continue;
    }
    try {
      await action(node);
      if (
        options.verify &&
        !options.verify(await observeMacComputerUseApp(app))
      ) {
        throw new Error(
          `Computer Use post-action verification failed for ${String(selector)}`
        );
      }
      return node;
    } catch (error) {
      lastError = error;
      if (!isStaleMacComputerUseError(error) || attempt === retries)
        throw error;
    }
  }
  throw lastError;
}

function extractNodeField(rest: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|, )${key}: ([^,]+)`).exec(rest);
  return match?.[1]?.trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
