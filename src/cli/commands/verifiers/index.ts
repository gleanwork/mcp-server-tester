import {
  currentMstCommand,
  planVerifiersRun,
  runVerifiersPlan,
  type VerifiersRunOptions,
} from '../../../verifiers/run.js';

/** `mst verifiers run <taskset>`: verifiers' `vf-run`, on an MST client. */
export async function verifiersRun(
  taskset: string,
  options: VerifiersRunOptions
): Promise<void> {
  const plan = planVerifiersRun(taskset, options, {
    mstCommand: currentMstCommand(),
  });
  console.error(
    `[mst] verifiers: vf-run ${plan.taskset}, client ${plan.config.env.agent.harness.client}, model ${options.model}`
  );
  const code = await runVerifiersPlan(plan);
  if (code !== 0) process.exitCode = code;
}
