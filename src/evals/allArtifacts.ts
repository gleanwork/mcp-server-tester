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
 * The most a trial's copy of its client artifacts may hold. A copy over a
 * limit fails. Here for the same reason as `ALL_ARTIFACTS`: a client can
 * check what it reports against them.
 */
export const ARTIFACT_LIMITS = {
  /** Bytes in one file. */
  fileBytes: 16 * 1024 * 1024,
  /** Bytes in the whole copy. */
  totalBytes: 64 * 1024 * 1024,
  /** Files and directories visited, included or not. */
  entries: 4096,
  /** Directories below the root. */
  depth: 16,
} as const;

/**
 * Where a trial's own folder (a timed-out task's session) keeps its failure
 * diagnosis: what the app showed, and its logs. Evidence for whoever reads
 * the run, not the task's output: judges don't see it.
 */
export const DIAGNOSIS_DIR = 'mst-diagnosis';
