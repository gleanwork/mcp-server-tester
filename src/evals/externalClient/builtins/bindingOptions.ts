/**
 * Reading built-in capability options: a binding's `with` values take
 * precedence over the client config's `options`.
 */

export function stringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function configStringOption(
  config: { options?: Record<string, unknown> },
  key: string
): string | undefined {
  return stringOption(config.options, key);
}

export function runStringOption(
  config: { options?: Record<string, unknown> },
  binding: { with?: Record<string, unknown> },
  key: string
): string | undefined {
  return stringOption(binding.with, key) ?? configStringOption(config, key);
}
