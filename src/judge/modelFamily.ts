/**
 * Which model family a model ID belongs to, so MST can warn when a judge
 * grades a client from its own family (ADR 0009): a model tends to rate
 * its own family's answers higher.
 */

const FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['anthropic', /claude|anthropic/],
  ['openai', /(^|[/:.-])(gpt|o\d|chatgpt|codex)([.-]|$|\d)|openai/],
  ['google', /gemini|gemma|google/],
  ['mistral', /mistral|mixtral|codestral|magistral/],
  ['xai', /grok|xai/],
  ['deepseek', /deepseek/],
  ['meta', /llama/],
  ['qwen', /qwen|qwq/],
];

/** The model's family, or undefined when MST doesn't know it. */
export function modelFamily(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const id = model.toLowerCase();
  return FAMILIES.find(([, pattern]) => pattern.test(id))?.[0];
}

/** Whether the two models are known to be from the same family. */
export function sameModelFamily(
  a: string | undefined,
  b: string | undefined
): boolean {
  const family = modelFamily(a);
  return family !== undefined && family === modelFamily(b);
}
