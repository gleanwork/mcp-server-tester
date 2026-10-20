/** `--env-option key=value` flags as an object; a key may be given once. */
export function parseEnvOptions(
  flags: readonly string[]
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const flag of flags) {
    const separator = flag.indexOf('=');
    if (separator < 1)
      throw new Error(`--env-option takes key=value, got "${flag}"`);
    const key = flag.slice(0, separator);
    if (Object.hasOwn(options, key))
      throw new Error(`--env-option ${key} is given twice`);
    options[key] = flag.slice(separator + 1);
  }
  return options;
}
