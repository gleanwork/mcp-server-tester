/**
 * What broke around the client when an attempt ended as an infrastructure
 * failure (ADR 0010):
 *
 * - `client-app`: the desktop or CLI program MST drives crashed, wasn't
 *   available, didn't take the prompt, or gave output MST couldn't read.
 * - `workspace`: the client's workspace (Cowork's VM).
 * - `network`: a connection failed.
 * - `provider`: the model provider's API (a rate limit, a 503).
 * - `collection`: MST couldn't collect the trial's result (its shard ended
 *   without it, or its artifacts couldn't be copied).
 * - `deadline`: an MST deadline passed.
 * - `setup`: the eval, the case, a client setting or a permission.
 */
export type InfrastructureBreak =
  | 'client-app'
  | 'workspace'
  | 'network'
  | 'provider'
  | 'collection'
  | 'deadline'
  | 'setup';

/**
 * How a client's attempt at a case ended (ADR 0010). A `trial` is graded as
 * usual, even when the client errored or ran out of turns, time or context.
 * An `infrastructure` failure says nothing about the client: it is left out
 * of pass rates, and `mst run --resume` collects it again when `retryable`.
 */
export type TrialEnding =
  | { kind: 'trial' }
  | {
      kind: 'infrastructure';
      broke: InfrastructureBreak;
      /** Whether collecting the attempt again can end differently. */
      retryable: boolean;
      /** Why, in a sentence: the client's error when it gave one. */
      reason: string;
    };
