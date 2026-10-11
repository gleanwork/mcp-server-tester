/**
 * The simulated-writes file: one JSON line per write the dry-run proxy
 * simulated. The proxy appends to it (`recordSimulatedWrite` in
 * simulatedWrites.ts); MST reads it after each trial. Reading is in its own
 * module so MST's bundles don't carry the proxy's writer, nor the proxy MST's
 * reader.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/** One line of the simulated-writes file. */
const SimulatedWriteRecordSchema = z.object({
  format: z.literal('mst.simulated-write/v1'),
  time: z.string(),
  /** The server's label. */
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  /** What the client was told. */
  reply: z.unknown(),
});
export type SimulatedWriteRecord = z.infer<typeof SimulatedWriteRecordSchema>;

/** The simulated writes in `file`, in order; none when it doesn't exist yet. */
export async function readSimulatedWrites(
  file: string
): Promise<SimulatedWriteRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed = SimulatedWriteRecordSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        // A line cut short by a proxy that was killed mid-write.
        return [];
      }
    });
}
