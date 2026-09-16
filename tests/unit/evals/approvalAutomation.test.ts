import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalAutomationError,
  createAutomatedApprovalDriver,
  type ApprovalAdapter,
  type ApprovalJournal,
  type ApprovalObservation,
  type ApprovalPolicy,
  type ApprovalReceipt,
} from '../../../src/evals/approvalAutomation.js';

const ACTION = {
  kind: 'mcp_tool_call',
  attributes: {
    server: 'records',
    tool: 'lookup_record',
    arguments: { namespace: 'releases', reference: 'abc' },
  },
};
const POLICY: ApprovalPolicy = {
  id: 'fixture-read-only',
  maxTotalApprovals: 2,
  rules: [
    {
      id: 'lookup',
      kind: 'mcp_tool_call',
      match: {
        server: 'records',
        tool: 'lookup_record',
        arguments: { namespace: 'releases' },
      },
      maxUses: 1,
    },
  ],
};

function fixture(
  options: {
    observation?: ApprovalObservation<string> | null;
    approveError?: Error;
    verification?: 'applied' | 'not_applied' | 'unknown';
    journalError?: Error;
  } = {}
) {
  let complete = false;
  const calls: string[] = [];
  const receipts: ApprovalReceipt[] = [];
  const adapter: ApprovalAdapter<string> = {
    async observe() {
      calls.push('observe');
      return options.observation === undefined
        ? { id: 'card-1', action: ACTION, handle: 'token-1' }
        : options.observation;
    },
    async approve(observation) {
      calls.push(`approve:${observation.handle}`);
      if (options.approveError) throw options.approveError;
    },
    async verify() {
      calls.push('verify');
      complete = true;
      return options.verification ?? 'applied';
    },
  };
  const journal: ApprovalJournal = {
    async append(receipt) {
      calls.push(`journal:${receipt.state}`);
      if (options.journalError) throw options.journalError;
      receipts.push(receipt);
    },
  };
  const driver = createAutomatedApprovalDriver({
    policy: POLICY,
    adapter,
    journal,
    pollIntervalMs: 1,
  });
  return {
    calls,
    receipts,
    run: () =>
      driver.drive({
        host: 'cowork',
        isolationKey: 'profile-1',
        deadline: Date.now() + 1000,
        isComplete: () => complete,
      }),
  };
}

describe('automated approval driver', () => {
  it('writes ahead, approves once, verifies, and records completion', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ approvals: 1 });
    expect(f.calls).toEqual([
      'observe',
      'journal:armed',
      'approve:token-1',
      'verify',
      'journal:applied',
    ]);
    expect(f.receipts.map((receipt) => receipt.state)).toEqual([
      'armed',
      'applied',
    ]);
    expect(f.receipts[0]).toMatchObject({
      version: 1,
      host: 'cowork',
      isolationKey: 'profile-1',
      policyId: POLICY.id,
      ruleId: 'lookup',
      actionKind: 'mcp_tool_call',
      decision: 'allow_once',
    });
    expect(f.receipts[0]?.actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.receipts[0]?.observationHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches nested policy fragments without requiring evaluator answers', async () => {
    const f = fixture({
      observation: {
        id: 'card-2',
        handle: 'token-2',
        action: {
          ...ACTION,
          attributes: {
            ...ACTION.attributes,
            arguments: { namespace: 'releases', reference: 'different' },
          },
        },
      },
    });
    await expect(f.run()).resolves.toEqual({ approvals: 1 });
  });

  it('refuses an unapproved action without dispatch', async () => {
    const f = fixture({
      observation: {
        id: 'card-2',
        handle: 'token-2',
        action: {
          kind: 'mcp_tool_call',
          attributes: { server: 'decoy', tool: 'lookup_record' },
        },
      },
    });
    await expect(f.run()).rejects.toMatchObject({ quarantine: false });
    expect(f.calls).toEqual(['observe']);
  });

  it('does not dispatch when the write-ahead journal fails', async () => {
    const f = fixture({ journalError: new Error('disk full') });
    await expect(f.run()).rejects.toMatchObject({ quarantine: false });
    expect(f.calls).toEqual(['observe', 'journal:armed']);
  });

  it.each([
    ['dispatch failure', { approveError: new Error('lost acknowledgement') }],
    ['unknown verification', { verification: 'unknown' as const }],
  ])('quarantines after %s', async (_name, options) => {
    const f = fixture(options);
    await expect(f.run()).rejects.toMatchObject({ quarantine: true });
    expect(f.calls).toContain('approve:token-1');
  });

  it('stops after a bounded target approval without host completion', async () => {
    const calls: string[] = [];
    const driver = createAutomatedApprovalDriver({
      policy: POLICY,
      adapter: {
        async observe() {
          calls.push('observe');
          return { id: 'card-1', action: ACTION, handle: 'token' };
        },
        async approve() {
          calls.push('approve');
        },
        async verify() {
          calls.push('verify');
          return 'applied';
        },
      },
      journal: { async append() {} },
    });
    await expect(
      driver.drive({
        host: 'cowork',
        isolationKey: 'profile-1',
        deadline: Date.now() + 1000,
        targetApprovals: 1,
        isComplete: () => false,
      })
    ).resolves.toEqual({ approvals: 1 });
    expect(calls).toEqual(['observe', 'approve', 'verify']);
  });

  it('returns without observing when host completion already settled', async () => {
    const observe = vi.fn();
    const driver = createAutomatedApprovalDriver({
      policy: POLICY,
      adapter: {
        observe,
        async approve() {},
        async verify() {
          return 'applied';
        },
      },
      journal: { async append() {} },
    });
    await expect(
      driver.drive({
        host: 'codex',
        isolationKey: 'profile-2',
        deadline: Date.now() + 1000,
        isComplete: () => true,
      })
    ).resolves.toEqual({ approvals: 0 });
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    {
      ...POLICY,
      rules: [{ ...POLICY.rules[0]!, match: { tool: '*' } }],
    },
    {
      ...POLICY,
      rules: [{ ...POLICY.rules[0]!, maxUses: 0 }],
    },
    { ...POLICY, maxTotalApprovals: 0 },
  ])('rejects unsafe policy definitions', (policy) => {
    expect(() =>
      createAutomatedApprovalDriver({
        policy,
        adapter: {
          async observe() {
            return null;
          },
          async approve() {},
          async verify() {
            return 'not_applied';
          },
        },
        journal: { async append() {} },
      })
    ).toThrow(ApprovalAutomationError);
  });
});
