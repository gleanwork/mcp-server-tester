import contract from '../../../scripts/chatgpt_linux_contract.json' with { type: 'json' };

/** The one Node reader of the contract shared with scripts/chatgpt_linux.py. */
export const LINUX_CHATGPT_ERROR_CODES = contract.errorCodes as [
  string,
  ...string[],
];

/** Desktop variables the Node adapter forwards to the Python runtime. */
export const LINUX_CHATGPT_RUNTIME_ENVIRONMENT: readonly string[] = [
  ...contract.sessionEnvironment,
  ...contract.profileEnvironment,
  ...contract.runtimeEnvironment,
];

/** Desktop variables forwarded to the caller-owned app controller. */
export const LINUX_CHATGPT_CONTROLLER_ENVIRONMENT: readonly string[] = [
  ...contract.sessionEnvironment,
  ...contract.controllerEnvironment,
];

export const NATIVE_MAX_ACTIONS = contract.maxActions;

export function pickEnvironment(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
}
