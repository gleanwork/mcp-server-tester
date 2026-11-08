/** `--runner-option key=value` flags as an object; a key may be given once. */
export function parseRunnerOptions(
  flags: readonly string[]
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const flag of flags) {
    const separator = flag.indexOf('=');
    if (separator < 1)
      throw new Error(`--runner-option takes key=value, got "${flag}"`);
    const key = flag.slice(0, separator);
    if (Object.hasOwn(options, key))
      throw new Error(`--runner-option ${key} is given twice`);
    options[key] = flag.slice(separator + 1);
  }
  return options;
}
