import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  MacComputerUseApp,
  MacComputerUseProvider,
} from './macComputerUse.js';

const execFileAsync = promisify(execFile);
const bridgeSourceUrl = new URL(
  './macComputerUseBridge.swift',
  import.meta.url
);

interface BridgeResponse {
  ok: boolean;
  state?: string;
  screenshot?: string;
  error?: string;
}

class NativeMacComputerUseApp implements MacComputerUseApp {
  constructor(
    private readonly bridge: NativeMacComputerUseBridge,
    private readonly appName: string
  ) {}

  async getAXStateAndScreenshot() {
    const response = await this.bridge.request({
      op: 'observe',
      app: this.appName,
    });
    return { state: response.state ?? '', screenshot: response.screenshot };
  }

  async click(elementIndex: number) {
    return this.bridge.request({
      op: 'click',
      app: this.appName,
      index: elementIndex,
    });
  }

  async setValue(elementIndex: number, value: string) {
    return this.bridge.request({
      op: 'setValue',
      app: this.appName,
      index: elementIndex,
      value,
    });
  }

  async pressKey(key: string) {
    return this.bridge.request({ op: 'pressKey', app: this.appName, key });
  }
}

class NativeMacComputerUseBridge {
  private child?: ChildProcessWithoutNullStreams;
  private output?: Interface;
  private pending = Promise.resolve();

  async start(): Promise<void> {
    if (this.child) return;
    const executable = await compileBridge();
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.output = createInterface({ input: this.child.stdout });
    this.child.stderr.on('data', () => undefined);
    this.child.once('exit', (code, signal) => {
      this.child = undefined;
      this.output?.close();
      this.output = undefined;
      if (code !== 0 || signal) {
        // The next request reports the unavailable bridge instead of reusing a dead process.
      }
    });
  }

  async request(command: Record<string, unknown>): Promise<BridgeResponse> {
    const operation = this.pending.then(async () => {
      await this.start();
      if (!this.child || !this.output) {
        throw new Error('Native macOS Computer Use bridge is not running.');
      }
      const response = new Promise<BridgeResponse>((resolve, reject) => {
        const onLine = (line: string) => {
          this.output?.removeListener('line', onLine);
          try {
            const parsed = JSON.parse(line) as BridgeResponse;
            if (!parsed.ok) {
              reject(new Error(parsed.error ?? 'Native CUA action failed.'));
            } else {
              resolve(parsed);
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        this.output?.on('line', onLine);
        this.child?.once('error', (error) => reject(error));
      });
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
      return response;
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

export function createNativeMacComputerUseProvider(): MacComputerUseProvider {
  const bridges = new Map<string, NativeMacComputerUseBridge>();
  return {
    id: 'native-macos',
    displayName: 'MST native macOS Accessibility/CoreGraphics provider',
    async getApp(appName) {
      let bridge = bridges.get(appName);
      if (!bridge) {
        bridge = new NativeMacComputerUseBridge();
        bridges.set(appName, bridge);
      }
      return new NativeMacComputerUseApp(bridge, appName);
    },
  };
}

async function compileBridge(): Promise<string> {
  const sourcePath = decodeURIComponent(bridgeSourceUrl.pathname);
  const sourceStat = await stat(sourcePath);
  const cacheDir = join(tmpdir(), 'mcp-server-tester-cua');
  const executable = join(
    cacheDir,
    `mac-cua-bridge-${Math.floor(sourceStat.mtimeMs)}`
  );
  try {
    await stat(executable);
    return executable;
  } catch {
    await mkdir(cacheDir, { recursive: true });
    await execFileAsync('/usr/bin/swiftc', [sourcePath, '-o', executable], {
      timeout: 120_000,
    });
    return executable;
  }
}
