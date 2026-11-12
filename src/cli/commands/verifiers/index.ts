import {
  currentMstCommand,
  planVerifiersRun,
  runVerifiersPlan,
  type VerifiersRunOptions,
} from '../../../verifiers/run.js';

/** `mst verifiers run <taskset>`: run a verifiers taskset on an MST client. */
export async function verifiersRun(
  taskset: string,
  options: VerifiersRunOptions
): Promise<void> {
  const plan = planVerifiersRun(taskset, options, {
    mstCommand: currentMstCommand(),
  });
  console.error(
    `[mst] verifiers: taskset ${plan.taskset}, client ${String(
      (plan.config.harness as { client: string }).client
    )}, model ${options.model}`
  );
  const code = await runVerifiersPlan(plan);
  if (code !== 0) process.exitCode = code;
}
