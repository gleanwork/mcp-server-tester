import { createHash, randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MCPConfigSchema } from '../../config/mcpConfig.js';
import type {
  HostDefinition,
  HostRunContext,
  HostRunInput,
  HostRunResult,
} from '../evalFrameworkTypes.js';
import type { HostConfig } from '../evalManifest.js';
import { createAutomatedApprovalDriver } from '../approvalAutomation.js';
import {
  createCuaCoworkApprovalAdapter,
  createCuaCoworkAutoModeAdapter,
} from './approval.js';
import { createCuaCoworkControl } from './cuaControl.js';
import {
  bounded,
  CoworkOperationScope,
  errorMessage,
  isRecord,
  remaining,
  requiresQuarantine,
} from './deadline.js';
import { createCoworkNativeEvidence } from './nativeEvidence.js';
import type {
  CoworkControl,
  CoworkEvidenceDiagnostics,
  CoworkHostOptions,
} from './types.js';
import { CoworkControlError, submitCoworkPrompt } from './workflow.js';

const BUNDLE_ID = 'com.anthropic.claudefordesktop';
// Shared even between multiple package copies/ESM and CJS in this JS runtime.
const leaseKey = Symbol.for('mcp-server-tester.cowork-lease');
const runtime = globalThis as unknown as Record<symbol, unknown>;
const lease = (runtime[leaseKey] ??= { active: false }) as { active: boolean };

export function createCoworkHost(
  dependencies: CoworkHostOptions
): HostDefinition {
  const {
    dataDir,
    checkpoint,
    record,
    isProcessAlive = processAlive,
  } = dependencies;
  const name = dependencies.name ?? 'cowork';
  const approval = dependencies.approval;
  const createControl =
    dependencies.createControl ??
    ((context) => createCuaCoworkControl(context, { alreadyFrontmost: true }));
  if (
    !name.trim() ||
    !isAbsolute(dataDir) ||
    typeof dependencies.cua?.call !== 'function' ||
    typeof checkpoint !== 'function' ||
    (dependencies.application !== undefined &&
      (typeof dependencies.application.launch !== 'function' ||
        typeof dependencies.application.activate !== 'function' ||
        typeof dependencies.application.stop !== 'function')) ||
    (approval !== undefined &&
      (!approval.isolationKey.trim() ||
        typeof approval.journal?.append !== 'function' ||
        !Array.isArray(approval.servers) ||
        approval.servers.length < 1))
  )
    throw new TypeError(
      'Cowork requires a name, persistent Cua transport, absolute dataDir, and checkpoint persistence'
    );
  // Do not let caller mutation alter preflight authorization or transport identity.
  const cuaCall = dependencies.cua.call.bind(dependencies.cua);
  const expectedServers = structuredClone(dependencies.expectedServers);
  expectedServers.forEach((server) => {
    MCPConfigSchema.parse(server);
    if (
      server.transport === 'http' &&
      server.auth?.accessTokenEnv !== undefined
    ) {
      throw new TypeError(
        'runtime auth environment references are unsupported; verify provisioned credentials before creating the host'
      );
    }
  });
  const labels = expectedServers.map((server) => server.label);
  if (
    approval?.servers.some(
      (server) => !labels.includes(server.label) || !server.displayName.trim()
    )
  )
    throw new TypeError(
      'Approval server identities must match provisioned server labels'
    );
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length)
    throw new TypeError(
      'expectedServers require unique provisioned server labels'
    );
  const prefixes = structuredClone(dependencies.mcpServerPrefixes);
  if (
    Object.values(prefixes).some((label) => !labels.includes(label)) ||
    labels.some((label) => !Object.values(prefixes).includes(label!))
  )
    throw new TypeError(
      'MCP prefixes must map exactly to provisioned expected server labels'
    );
  const nativeEvidence = createCoworkNativeEvidence({
    mcpServerPrefixes: prefixes,
    requireMcpResults: dependencies.requireMcpResults,
  });
  const evidence = dependencies.evidence ?? nativeEvidence;
  const schema = z
    .object({
      type: z.literal(name),
      timeout: z.number().int().min(1).max(600_000).default(120_000),
      cleanupTimeoutMs: z.number().int().min(10).max(30_000).default(15_000),
      pollIntervalMs: z.number().int().min(1).max(1000).default(100),
    })
    .strict();
  return { name, schema, evidence: 'structured', run };

  async function run(
    input: HostRunInput,
    config: HostConfig,
    context: HostRunContext
  ): Promise<HostRunResult> {
    let result: HostRunResult = { finalText: '', events: [] };
    if (lease.active)
      return fail(
        result,
        'lease',
        'worker active or quarantined; concurrent Cowork run refused'
      );
    lease.active = true;
    const startedAtMs = Date.now();
    const marker = `MCP_SERVER_TESTER_COWORK_${randomUUID()}`;
    const text = `${input.scenario}\n\n${marker}`;
    let stage = 'config';
    let options: z.output<typeof schema> | undefined;
    let scope: CoworkOperationScope | undefined;
    let ownedPid: number | undefined;
    let windowId: number | undefined;
    let launchAttempted = false;
    let safeToRelease = true;
    let submitArmed = false;
    let ownedProcessStopped = false;
    let diagnostics: CoworkEvidenceDiagnostics | undefined;
    let submitAcknowledgementError: string | undefined;
    let automatedApprovalCount = 0;
    try {
      options = schema.parse(config);
      scope = new CoworkOperationScope(startedAtMs + options.timeout);
      if (!isDeepStrictEqual(input.servers, expectedServers))
        throw new Error(
          'unsupported servers: provisioned configuration must match exactly, including environment and auth'
        );
      validateOverrides(input, context);
      if (!input.scenario.trim())
        throw new Error('scenario must be nonempty text');
      if (platform() !== 'darwin')
        throw new Error('Cowork control is macOS-only');
      stage = 'permissions';
      const permissions = await call('check_permissions', { prompt: false });
      if (
        permissions.accessibility !== true ||
        permissions.screen_recording !== true
      )
        throw new Error(
          'Accessibility and Screen Recording grants are required'
        );
      stage = 'preexisting_app';
      const catalog = await call('list_apps', {});
      if (!Array.isArray(catalog.apps) || !catalog.apps.every(isRecord))
        throw new Error('unverified app catalog');
      if (
        catalog.apps.some(
          (app) =>
            (app.bundle_id === BUNDLE_ID || app.name === 'Claude') &&
            (app.running || positiveInteger(app.pid))
        )
      )
        throw new Error(
          'preexisting Claude process: refusing to borrow or terminate it'
        );
      stage = 'snapshot';
      const snapshot = await scope.run(() => evidence.snapshot(dataDir));
      stage = 'launch';
      launchAttempted = true;
      const acquireOwnedPid = (pid: unknown) => {
        if (
          !positiveInteger(pid) ||
          (ownedPid !== undefined && ownedPid !== pid)
        ) {
          throw new Error('launch returned invalid or conflicting ownership');
        }
        ownedPid = pid;
      };
      if (dependencies.application) {
        await scope.run(() =>
          dependencies.application!.launch(acquireOwnedPid)
        );
      } else {
        await call('launch_app', { bundle_id: BUNDLE_ID }, (data) => {
          // Capture ownership even when an error/late acknowledgement follows launch.
          acquireOwnedPid(data?.pid);
        });
      }
      if (!ownedPid) throw new Error('launch returned no owned PID');
      if (dependencies.application) {
        stage = 'activate';
        await scope.run(() =>
          dependencies.application!.activate(ownedPid!, 'claude://cowork/new')
        );
      }
      stage = 'window';
      while (windowId === undefined) {
        const data = await call('list_windows', {
          pid: ownedPid,
          on_screen_only: false,
        });
        if (!Array.isArray(data.windows) || !data.windows.every(isRecord))
          throw new Error('unverified window catalog');
        const candidates = data.windows.filter((window) =>
          mainWindowCandidate(window, ownedPid!)
        );
        const visible = candidates.filter(
          (window) =>
            window.is_on_screen === true && window.on_current_space !== false
        );
        const eligible = visible.length > 0 ? visible : candidates;
        if (eligible.length > 1) throw new Error('ambiguous main windows');
        if (eligible.length) {
          if (!positiveInteger(eligible[0]!.window_id))
            throw new Error('invalid window identity');
          windowId = eligible[0]!.window_id;
        } else
          await sleep(
            Math.min(options.pollIntervalMs, remaining(scope.deadline))
          );
      }
      stage = 'focus';
      await call('bring_to_front', { pid: ownedPid, window_id: windowId });
      const visible = await call('list_windows', {
        pid: ownedPid,
        on_screen_only: true,
      });
      if (
        !Array.isArray(visible.windows) ||
        !visible.windows.some(
          (window) =>
            isRecord(window) &&
            window.window_id === windowId &&
            window.is_on_screen === true &&
            mainWindowCandidate(window, ownedPid!)
        )
      )
        throw new Error('owned main window did not become visible');
      stage = 'pre_submit';
      const pid = ownedPid;
      const mainWindowId = windowId;
      const execution = scope;
      const control = trackControl(
        createControl({ call, pid, windowId: mainWindowId }),
        execution
      );
      const submitted = await execution.run(() =>
        submitCoworkPrompt({
          control,
          text,
          deadline: execution.deadline,
          pollIntervalMs: options!.pollIntervalMs,
          permissionPolicy: approval ? 'automated-hitl' : 'automatic-mode',
          routePrepared: dependencies.application !== undefined,
          onStage: (substage) => {
            stage = `pre_submit_${substage}`;
          },
          preparePermissions: approval
            ? async () => {
                const adapter = approval.createModeAdapter
                  ? approval.createModeAdapter({
                      pid,
                      windowId: mainWindowId,
                      call,
                    })
                  : createCuaCoworkAutoModeAdapter({
                      pid,
                      windowId: mainWindowId,
                      call,
                    });
                const driver = createAutomatedApprovalDriver({
                  policy: approval.modePolicy,
                  adapter,
                  journal: approval.journal,
                  pollIntervalMs: options!.pollIntervalMs,
                });
                const prepared = await driver.drive({
                  host: name,
                  isolationKey: approval.isolationKey,
                  deadline: execution.deadline,
                  targetApprovals: 1,
                  isComplete: () => false,
                });
                automatedApprovalCount += prepared.approvals;
              }
            : undefined,
          async beforeSubmit(details) {
            remaining(execution.deadline);
            if (submitArmed)
              throw new Error('submission already armed; never resubmit');
            await execution.run(() =>
              checkpoint({
                status: 'armed',
                marker,
                startedAtMs,
                deadline: execution.deadline,
                pid,
                windowId: mainWindowId,
                baselineSessions: [...snapshot].map(
                  ([metadataPath, entry]) => ({
                    metadataPath,
                    mtimeMs: entry.mtimeMs,
                  })
                ),
                promptSha256: createHash('sha256').update(text).digest('hex'),
                ...details,
              })
            );
            submitArmed = true;
          },
        })
      );
      submitAcknowledgementError = submitted.acknowledgementError;
      stage = 'evidence';
      // Reconcile uncertain acknowledgement without another submit or a new budget.
      let evidenceSettled = false;
      const evidenceOperation = execution
        .run(() =>
          evidence.collect({
            dataDir,
            marker,
            snapshot,
            startedAtMs,
            timeoutMs: remaining(execution.deadline),
            expectedPrompt: text,
          })
        )
        .finally(() => {
          evidenceSettled = true;
        });
      const approvalOperation = approval
        ? execution.run(async () => {
            const adapter = approval.createAdapter
              ? approval.createAdapter({
                  pid,
                  windowId: mainWindowId,
                  call,
                })
              : createCuaCoworkApprovalAdapter({
                  pid,
                  windowId: mainWindowId,
                  call,
                  servers: approval.servers,
                });
            const driver = createAutomatedApprovalDriver({
              policy: approval.policy,
              adapter,
              journal: approval.journal,
              pollIntervalMs: options!.pollIntervalMs,
            });
            return driver.drive({
              host: name,
              isolationKey: approval.isolationKey,
              deadline: execution.deadline,
              isComplete: () => evidenceSettled,
            });
          })
        : Promise.resolve({ approvals: 0 });
      const [collected, approvalResult] = await Promise.all([
        evidenceOperation,
        approvalOperation,
      ]);
      automatedApprovalCount += approvalResult.approvals;
      diagnostics = collected.diagnostics;
      if (
        typeof collected.trace?.finalText !== 'string' ||
        !Array.isArray(collected.trace.events)
      )
        throw new Error('invalid native trace');
      result = collected.trace;
      if (
        !diagnostics.complete ||
        diagnostics.evidence !== 'structured' ||
        diagnostics.fullPromptConfirmed !== true
      )
        result = fail(
          result,
          'evidence',
          'complete full-prompt-correlated structured trace unavailable'
        );
    } catch (error) {
      if (requiresQuarantine(error)) safeToRelease = false;
      result = fail(result, stage, errorMessage(error));
    } finally {
      const cleanupMs = options?.cleanupTimeoutMs ?? 5000;
      const cleanupEnd = Date.now() + cleanupMs;
      if (scope?.pendingCount) {
        try {
          await scope.drain(
            Math.min(cleanupEnd, Date.now() + Math.min(2000, cleanupMs / 2))
          );
        } catch {
          safeToRelease = false;
          result = fail(
            result,
            'quarantine',
            'operations did not settle within cleanup allowance'
          );
        }
      }
      if (launchAttempted && !ownedPid) {
        safeToRelease = false;
        result = fail(
          result,
          'quarantine',
          'launch ownership is unknown; no automatic retry'
        );
      }
      if (ownedPid && scope) {
        const safeForOwnedStop = !submitArmed || diagnostics?.complete === true;
        if (dependencies.application && safeForOwnedStop) {
          try {
            await bounded(
              () => dependencies.application!.stop(ownedPid!, cleanupMs),
              cleanupEnd
            );
            ownedProcessStopped = true;
          } catch (error) {
            safeToRelease = false;
            result = fail(result, 'cleanup', errorMessage(error));
          }
        } else if (dependencies.application) {
          safeToRelease = false;
          result = fail(
            result,
            'quarantine',
            'submitted work lacks terminal evidence; owned application retained'
          );
        } else {
          try {
            await cleanup(ownedPid, windowId, cleanupEnd, scope);
            ownedProcessStopped = !(await isProcessAlive(ownedPid));
          } catch (error) {
            safeToRelease = false;
            result = fail(result, 'cleanup', errorMessage(error));
          }
        }
      }
      if (scope?.pendingCount) {
        safeToRelease = false;
        result = fail(
          result,
          'quarantine',
          'cleanup left outstanding operations'
        );
      }
      if (scope?.quarantineRequired) {
        safeToRelease = false;
        result = fail(
          result,
          'quarantine',
          'an operation reported uncertain external state; no automatic retry'
        );
      }
      if (record) {
        try {
          await bounded(
            () =>
              record({
                marker,
                startedAtMs,
                stage,
                ownedPid,
                ownedProcessStopped,
                submitArmed,
                quarantined: !safeToRelease,
                diagnostics,
                submitAcknowledgementError,
                automatedApprovalCount,
              }),
            Date.now() + 1000
          );
        } catch {
          result = fail(
            result,
            'record',
            'private diagnostic persistence failed'
          );
        }
      }
      lease.active = !safeToRelease;
    }
    return result;

    async function call(
      name: string,
      args: Record<string, unknown>,
      acquired?: (data: Record<string, unknown> | undefined) => void
    ): Promise<Record<string, unknown>> {
      const execution = scope!;
      return execution.run(async () => {
        const raw = await cuaCall(name, args, remaining(execution.deadline));
        acquired?.(raw.structuredContent);
        if (
          name === 'launch_app' &&
          !acquired &&
          raw.structuredContent?.pid !== ownedPid
        )
          safeToRelease = false;
        return decode(raw, name);
      });
    }
    async function cleanup(
      pid: number,
      mainWindowId: number | undefined,
      end: number,
      execution: CoworkOperationScope
    ): Promise<void> {
      const cooperativeEnd =
        Date.now() + Math.floor(Math.max(0, end - Date.now()) / 2);
      const errors: string[] = [];
      async function alive(): Promise<boolean> {
        return execution.run(() => isProcessAlive(pid), end);
      }
      async function waitForExit(until: number): Promise<boolean> {
        do {
          if (!(await alive())) return true;
          if (Date.now() >= until) return false;
          await sleep(
            Math.min(options?.pollIntervalMs ?? 100, until - Date.now())
          );
        } while (Date.now() <= until);
        return false;
      }
      if (!(await alive())) return;
      if (mainWindowId !== undefined) {
        try {
          decode(
            await execution.run(
              () =>
                cuaCall(
                  'press_key',
                  {
                    pid,
                    window_id: mainWindowId,
                    key: 'q',
                    modifiers: ['cmd'],
                    delivery_mode: 'foreground',
                  },
                  remaining(cooperativeEnd)
                ),
              cooperativeEnd
            ),
            'press_key'
          );
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
      if (
        !(await waitForExit(
          mainWindowId === undefined ? Date.now() : cooperativeEnd
        ))
      ) {
        try {
          decode(
            await execution.run(
              () => cuaCall('kill_app', { pid }, remaining(end)),
              end
            ),
            'kill_app',
            true
          );
        } catch (error) {
          errors.push(errorMessage(error));
        }
        if (!(await waitForExit(end))) errors.push('owned PID did not exit');
      }
      if (errors.length) throw new Error(errors.join('; '));
    }
  }
  function fail(
    trace: HostRunResult,
    stage: string,
    message: string
  ): HostRunResult {
    return {
      ...trace,
      error: [trace.error, `${name}:${stage}: ${message}`]
        .filter(Boolean)
        .join('; '),
    };
  }
}

function trackControl(
  control: CoworkControl,
  scope: CoworkOperationScope
): CoworkControl {
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Track individual failures before the workflow can handle or wrap them.
      return await scope.run(operation);
    } catch (error) {
      if (requiresQuarantine(error)) {
        // Do not copy potentially sensitive clipboard contents into the trace.
        throw new CoworkControlError('control operation requires quarantine', {
          quarantine: true,
        });
      }
      throw error;
    }
  }
  return {
    openUrl(url) {
      return invoke(() => control.openUrl(url));
    },
    observe() {
      return invoke(() => control.observe());
    },
    paste(text) {
      return invoke(() => control.paste(text));
    },
    setValue(text) {
      return invoke(() => control.setValue(text));
    },
    pressReturn() {
      return invoke(() => control.pressReturn());
    },
    clickSend() {
      return invoke(() => control.clickSend());
    },
  };
}

function validateOverrides(input: HostRunInput, context: HostRunContext): void {
  const values: unknown[] = [
    input,
    context,
    context.manifest,
    context.arm,
    context.manifest.host,
    context.arm?.host,
  ];
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.env !== undefined || value.auth !== undefined)
      throw new Error(
        'per-run environment/auth overrides are unsupported; runEvalSuite environment expansion is not supported'
      );
    if (value.toolOverrides !== undefined)
      throw new Error('toolOverrides are unsupported');
  }
  if (context.mcpHostConfig !== undefined)
    throw new Error(
      'mcpHostConfig overrides are unsupported by the provisioned Cowork app'
    );
}
function mainWindowCandidate(
  window: Record<string, unknown>,
  pid: number
): boolean {
  return (
    window.pid === pid &&
    window.layer === 0 &&
    isRecord(window.bounds) &&
    typeof window.bounds.width === 'number' &&
    window.bounds.width > 500 &&
    typeof window.bounds.height === 'number' &&
    window.bounds.height > 300
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') return false;
    throw error;
  }
}
function decode(
  raw: CallToolResult,
  name: string,
  allowVoidAcknowledgement = false
): Record<string, unknown> {
  const data = raw.structuredContent;
  // Cua 0.28 kill_app may return text only. OS exit is still independently checked.
  if (
    allowVoidAcknowledgement &&
    !raw.isError &&
    !data &&
    Array.isArray(raw.content)
  )
    return {};
  if (raw.isError || !isRecord(data) || data.error || data.success === false)
    throw new Error(`Cua ${name} failed or lacked structured acknowledgement`);
  return data;
}
