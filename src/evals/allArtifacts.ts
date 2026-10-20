/**
 * Copies everything, hidden names too: for a stored copy, which only holds
 * what its client included.
 *
 * In a module of its own, without imports: a client in the main bundle uses
 * it, and importing it from trialArtifacts.ts would bring that module's file
 * code (and its unused imports) into the bundle.
 */
export const ALL_ARTIFACTS: readonly string[] = ['**'];

/**
 * Where a trial's own folder (a timed-out task's session) keeps its failure
 * diagnosis: what the app showed, and its logs. Evidence for whoever reads
 * the run, not the task's output: judges don't see it.
 */
export const DIAGNOSIS_DIR = 'mst-diagnosis';
