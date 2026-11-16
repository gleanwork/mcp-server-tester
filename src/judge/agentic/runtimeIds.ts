/**
 * The agentic judge runtimes MST ships. Kept apart from agenticJudge.ts so
 * the model defaults (`src/llm/modelDefaults.ts`) can key on them without
 * loading the runtimes.
 */
export const AGENT_JUDGE_RUNTIMES = ['codex', 'claude-agent'] as const;
export type AgentJudgeRuntimeId = (typeof AGENT_JUDGE_RUNTIMES)[number];
