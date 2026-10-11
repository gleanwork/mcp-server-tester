/**
 * The legacy-era revisions, in their own module: only the public API reads
 * them, so bundles that use `protocol.ts` (the fixtures, the CLI) leave this
 * module and its SDK import out instead of carrying an unused import.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';

/** Legacy-era revisions the SDK can negotiate, newest first. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] =
  SUPPORTED_PROTOCOL_VERSIONS;
