/**
 * The write record's format name, on every line (ADR 0014). Its own module so
 * the proxy's writer (writeRecordWriter.ts) and MST's reader
 * (writeRecordLines.ts) share it without either bundle carrying the other.
 */
export const WRITE_RECORD_FORMAT = 'mst.write-record/v1' as const;
