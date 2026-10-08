/**
 * A client couldn't run a batch at all: its desktop, machine or service is
 * unavailable (leased by another run, unreachable, not provisioned). An eval
 * records each of the batch's trials as an infrastructure failure that says
 * why, and goes on with the next variant.
 *
 * Throw it from a client's `runBatch` only for that. Any other error (a bad
 * option, a server that isn't ready) stops the run, keeping the variants that
 * finished.
 */
export class ClientUnavailableError extends Error {
  override readonly name = 'ClientUnavailableError';
}

/** Also true for a redacted copy, which keeps the name but not the class. */
export function isClientUnavailable(error: unknown): boolean {
  return (
    error instanceof ClientUnavailableError ||
    (error instanceof Error && error.name === 'ClientUnavailableError')
  );
}
