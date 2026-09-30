/** The message of an Error, or the value converted to a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
