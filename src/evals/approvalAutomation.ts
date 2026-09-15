import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export type ApprovalJson =
  | null
  | boolean
  | number
  | string
  | ApprovalJson[]
  | { [key: string]: ApprovalJson };

export interface ApprovalAction {
  kind: string;
  attributes: Record<string, ApprovalJson>;
}

export interface ApprovalObservation<Handle> {
  /** Stable only for this displayed approval request. Never persisted raw. */
  id: string;
  action: ApprovalAction;
  handle: Handle;
}

export interface ApprovalRule {
  id: string;
  kind: string;
  /** Exact structural fragment. Unspecified fields may vary. */
  match: Record<string, ApprovalJson>;
  maxUses: number;
}

export interface ApprovalPolicy {
  id: string;
  maxTotalApprovals: number;
  rules: ApprovalRule[];
}

export interface ApprovalReceipt {
  version: 1;
  id: string;
  state: 'armed' | 'applied';
  host: string;
  isolationKey: string;
  policyId: string;
  policyHash: string;
  ruleId: string;
  actionKind: string;
  actionHash: string;
  observationHash: string;
  decision: 'allow_once';
  recordedAtMs: number;
}

export interface ApprovalJournal {
  /** Append durably. Implementations must never overwrite an existing state. */
  append(receipt: ApprovalReceipt): Promise<void>;
}

export interface ApprovalAdapter<Handle> {
  /** Return at most one unambiguous native approval request. */
  observe(): Promise<ApprovalObservation<Handle> | null>;
  /** Dispatch exactly one allow-once action. Never retry internally. */
  approve(observation: ApprovalObservation<Handle>): Promise<void>;
  /** Verify a fresh positive post-action state. Disappearance alone is insufficient. */
  verify(
    observation: ApprovalObservation<Handle>
  ): Promise<'applied' | 'not_applied' | 'unknown'>;
}

export interface ApprovalDriveInput {
  host: string;
  isolationKey: string;
  deadline: number;
  /** Stop after this many verified approvals, independent of host completion. */
  targetApprovals?: number;
  isComplete(): boolean;
}

export class ApprovalAutomationError extends Error {
  readonly fatal = true;
  readonly quarantine: boolean;

  constructor(message: string, options: { quarantine?: boolean } = {}) {
    super(message);
    this.name = 'ApprovalAutomationError';
    this.quarantine = options.quarantine ?? false;
  }
}

/** Drive bounded, policy-checked approvals while a host independently completes. */
export function createAutomatedApprovalDriver<Handle>(options: {
  policy: ApprovalPolicy;
  adapter: ApprovalAdapter<Handle>;
  journal: ApprovalJournal;
  pollIntervalMs?: number;
}): {
  drive(input: ApprovalDriveInput): Promise<{ approvals: number }>;
} {
  validatePolicy(options.policy);
  const policyHash = hashJson(options.policy as unknown as ApprovalJson);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new ApprovalAutomationError('Invalid approval poll interval.');

  return { drive };

  async function drive(
    input: ApprovalDriveInput
  ): Promise<{ approvals: number }> {
    validateDriveInput(input);
    if (
      input.targetApprovals !== undefined &&
      input.targetApprovals > options.policy.maxTotalApprovals
    )
      throw new ApprovalAutomationError(
        'Approval target exceeds the policy limit.'
      );
    const uses = new Map<string, number>();
    const seen = new Set<string>();
    let approvals = 0;
    while (!done(input, approvals)) {
      remaining(input.deadline);
      let observation: ApprovalObservation<Handle> | null;
      try {
        observation = await options.adapter.observe();
      } catch (error) {
        throw wrapped('Approval observation failed.', error, false);
      }
      if (done(input, approvals)) return { approvals };
      if (!observation) {
        await sleep(
          Math.min(pollIntervalMs, Math.max(1, input.deadline - Date.now()))
        );
        continue;
      }
      validateObservation(observation);
      const observationHash = hashText(observation.id);
      if (seen.has(observationHash))
        throw new ApprovalAutomationError(
          'A previously handled approval request reappeared.',
          { quarantine: true }
        );
      const matches = options.policy.rules.filter(
        (rule) =>
          rule.kind === observation.action.kind &&
          matchesFragment(rule.match, observation.action.attributes)
      );
      if (matches.length !== 1)
        throw new ApprovalAutomationError(
          matches.length === 0
            ? 'Native action is not approved by policy.'
            : 'Native action matches ambiguous approval rules.'
        );
      const rule = matches[0]!;
      const used = uses.get(rule.id) ?? 0;
      if (used >= rule.maxUses || approvals >= options.policy.maxTotalApprovals)
        throw new ApprovalAutomationError(
          'Approval policy use limit exceeded.'
        );
      const id = randomUUID();
      const base = {
        version: 1 as const,
        id,
        host: input.host,
        isolationKey: input.isolationKey,
        policyId: options.policy.id,
        policyHash,
        ruleId: rule.id,
        actionKind: observation.action.kind,
        actionHash: hashJson(observation.action as unknown as ApprovalJson),
        observationHash,
        decision: 'allow_once' as const,
      };
      try {
        await options.journal.append({
          ...base,
          state: 'armed',
          recordedAtMs: Date.now(),
        });
      } catch (error) {
        throw wrapped('Approval write-ahead journal failed.', error, false);
      }
      seen.add(observationHash);
      try {
        await options.adapter.approve(observation);
      } catch (error) {
        throw wrapped('Approval dispatch became uncertain.', error, true);
      }
      let verification: 'applied' | 'not_applied' | 'unknown';
      try {
        verification = await options.adapter.verify(observation);
      } catch (error) {
        throw wrapped('Approval verification became uncertain.', error, true);
      }
      if (verification !== 'applied')
        throw new ApprovalAutomationError(
          verification === 'not_applied'
            ? 'Approval was proven not applied.'
            : 'Approval outcome is uncertain.',
          { quarantine: verification === 'unknown' }
        );
      try {
        await options.journal.append({
          ...base,
          state: 'applied',
          recordedAtMs: Date.now(),
        });
      } catch (error) {
        throw wrapped(
          'Applied approval was not durably recorded.',
          error,
          true
        );
      }
      approvals++;
      uses.set(rule.id, used + 1);
    }
    return { approvals };
  }
}

function validatePolicy(policy: ApprovalPolicy): void {
  if (
    !identifier(policy.id) ||
    !Number.isInteger(policy.maxTotalApprovals) ||
    policy.maxTotalApprovals < 1 ||
    !Array.isArray(policy.rules) ||
    policy.rules.length < 1
  )
    throw new ApprovalAutomationError('Invalid approval policy.');
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (
      !identifier(rule.id) ||
      ids.has(rule.id) ||
      !identifier(rule.kind) ||
      !Number.isInteger(rule.maxUses) ||
      rule.maxUses < 1 ||
      !plainObject(rule.match) ||
      Object.keys(rule.match).length < 1 ||
      containsWildcard(rule.match)
    )
      throw new ApprovalAutomationError('Invalid approval policy rule.');
    ids.add(rule.id);
  }
}

function validateDriveInput(input: ApprovalDriveInput): void {
  if (
    !identifier(input.host) ||
    !identifier(input.isolationKey) ||
    !Number.isFinite(input.deadline) ||
    (input.targetApprovals !== undefined &&
      (!Number.isInteger(input.targetApprovals) ||
        input.targetApprovals < 1)) ||
    typeof input.isComplete !== 'function'
  )
    throw new ApprovalAutomationError('Invalid approval drive input.');
}

function done(input: ApprovalDriveInput, approvals: number): boolean {
  return (
    input.isComplete() ||
    (input.targetApprovals !== undefined && approvals >= input.targetApprovals)
  );
}

function validateObservation<Handle>(
  observation: ApprovalObservation<Handle>
): void {
  if (
    !identifier(observation.id) ||
    !identifier(observation.action?.kind) ||
    !plainObject(observation.action?.attributes)
  )
    throw new ApprovalAutomationError('Invalid approval observation.');
}

function matchesFragment(
  fragment: Record<string, ApprovalJson>,
  value: Record<string, ApprovalJson>
): boolean {
  return Object.entries(fragment).every(([key, expected]) =>
    matchesValue(expected, value[key])
  );
}

function matchesValue(
  expected: ApprovalJson,
  actual: ApprovalJson | undefined
): boolean {
  if (plainObject(expected))
    return plainObject(actual) && matchesFragment(expected, actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => matchesValue(item, actual[index]))
    );
  return Object.is(expected, actual);
}

function containsWildcard(value: ApprovalJson): boolean {
  if (typeof value === 'string') return value.includes('*');
  if (Array.isArray(value)) return value.some(containsWildcard);
  if (plainObject(value)) return Object.values(value).some(containsWildcard);
  return false;
}

function plainObject(value: unknown): value is Record<string, ApprovalJson> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 256
  );
}

function remaining(deadline: number): number {
  const milliseconds = deadline - Date.now();
  if (!(milliseconds > 0))
    throw new ApprovalAutomationError('Approval deadline exceeded.');
  return milliseconds;
}

function wrapped(
  message: string,
  error: unknown,
  afterDispatch: boolean
): ApprovalAutomationError {
  return new ApprovalAutomationError(message, {
    quarantine:
      afterDispatch || (plainObject(error) && error.quarantine === true),
  });
}

function hashJson(value: ApprovalJson): string {
  return hashText(canonicalJson(value));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: ApprovalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}
