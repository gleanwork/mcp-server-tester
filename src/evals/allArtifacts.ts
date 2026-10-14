/**
 * Copies everything, hidden names too: for a stored copy, which only holds
 * what its client included.
 *
 * In a module of its own, without imports: a client in the main bundle uses
 * it, and importing it from trialArtifacts.ts would bring that module's file
 * code (and its unused imports) into the bundle.
 */
export const ALL_ARTIFACTS: readonly string[] = ['**'];
