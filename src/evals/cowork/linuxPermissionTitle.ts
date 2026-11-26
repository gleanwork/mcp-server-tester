/** Cowork can omit one sentence-ending period from the scoped button title.
 * Keep the panel title verbatim; use this for the header and collision checks. */
export function permissionHeaderTitle(title: string): string {
  return title.replace(/([^.\s])\.$/u, '$1');
}
