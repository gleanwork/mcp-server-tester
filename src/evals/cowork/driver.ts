/** Desktop driver contracts. Runtime provisioning belongs to the caller/platform. */
export type CoworkDriverProvider = 'anthropic-computer-use' | 'linux-desktop';

export interface CoworkDriverOptions {
  deadlineAt: number;
  maxActions?: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Linux semantic approvals must not broaden the caller's write policy. */
  approveWriteTools?: boolean;
  /** Bound native session completion, never GUI text or another task. */
  isComplete?: () => Promise<boolean>;
}

export const COMPUTER_USE_TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;
export type ComputerUseTokenField = (typeof COMPUTER_USE_TOKEN_FIELDS)[number];

/** Usage totals cover only observed fields on completed planner responses. */
export interface ComputerUseTelemetry {
  accounting: 'complete' | 'partial';
  response_models: string[];
  planner_response_count: number;
  usage: Partial<Record<ComputerUseTokenField, number>>;
  usage_observation_counts: Record<ComputerUseTokenField, number>;
  duration_ms: number;
  action_count: number;
  attempted_action_count: number;
  executed_action_count: number;
  refused_action_count: number;
  cost: { status: 'unavailable' };
}

export interface SemanticDesktopTelemetry {
  driver: 'linux-desktop';
  accounting: 'complete' | 'partial';
  duration_ms: number;
  action_count: number;
  planner: { status: 'not-applicable' };
  cost: { status: 'not-applicable' };
}

export type CoworkDriverTelemetry =
  | ComputerUseTelemetry
  | SemanticDesktopTelemetry;

export interface CoworkSubmissionReceipt {
  status: 'submitted';
  action_count: number;
  telemetry?: CoworkDriverTelemetry;
}

export interface CoworkHitlReceipt {
  status: 'hitl_checked';
  action_count: number;
  telemetry?: CoworkDriverTelemetry;
}

export class CoworkDriverError extends Error {
  readonly kind: 'failed' | 'hitl-budget-exhausted' = 'failed';
  constructor(
    message: string,
    public readonly telemetry?: CoworkDriverTelemetry
  ) {
    super(message);
  }
}

export class CoworkHitlBudgetError extends CoworkDriverError {
  override readonly kind = 'hitl-budget-exhausted';
}
