/** A timeout is not cancellation. Retain operations until they actually settle. */
export class CoworkOperationScope {
  private readonly pending = new Set<Promise<unknown>>();
  private quarantineFailure = false;

  constructor(readonly deadline: number) {}

  get quarantineRequired(): boolean {
    return this.quarantineFailure;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    operation.then(
      () => this.pending.delete(operation),
      (error: unknown) => {
        // Preserve safety signals even if a deadline won the caller's race.
        this.quarantineFailure ||= requiresQuarantine(error);
        this.pending.delete(operation);
      }
    );
    return operation;
  }

  async run<T>(
    operation: () => T | Promise<T>,
    deadline = this.deadline
  ): Promise<T> {
    remaining(deadline);
    return bounded(
      () => this.track(Promise.resolve().then(operation)),
      deadline
    );
  }

  async drain(deadline: number): Promise<void> {
    // Settling an operation can enqueue a finalizer. Drain again until empty.
    while (this.pending.size > 0) {
      await bounded(() => Promise.allSettled([...this.pending]), deadline);
    }
  }
}

export function remaining(deadline: number): number {
  const milliseconds = deadline - Date.now();
  if (!(milliseconds > 0)) throw new Error('shared deadline exceeded');
  return milliseconds;
}

export async function bounded<T>(
  operation: () => T | Promise<T>,
  deadline: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('shared deadline exceeded')),
        remaining(deadline)
      );
    });
    const value = await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
    // Synchronous work can delay the timer callback past the deadline.
    remaining(deadline);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Caller errors and other package copies cannot rely on class identity. */
export function requiresQuarantine(error: unknown): boolean {
  return hasErrorFlag(error, 'quarantine');
}

/** Quarantine must prevent fallback even if the caller marks the error nonfatal. */
export function isFatalControlError(error: unknown): boolean {
  return requiresQuarantine(error) || hasErrorFlag(error, 'fatal');
}

function hasErrorFlag(error: unknown, flag: 'fatal' | 'quarantine'): boolean {
  try {
    return isRecord(error) && error[flag] === true;
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
