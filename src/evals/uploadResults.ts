import fs from 'node:fs/promises';
import path from 'node:path';

interface GCSFile {
  save(data: Buffer, options?: { resumable?: boolean }): Promise<void>;
}

interface GCSBucket {
  file(name: string): GCSFile;
}

interface GCSStorage {
  bucket(name: string): GCSBucket;
}

interface GCSModule {
  Storage: new () => GCSStorage;
}

function parseGcsUri(uri: string): { bucket: string; prefix: string } {
  const match = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(uri);
  if (!match) throw new Error(`Expected a gs:// URI, received: ${uri}`);
  return { bucket: match[1]!, prefix: match[2]?.replace(/\/+$/, '') ?? '' };
}

async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else files.push(child);
  }
  return files;
}

/** Upload a batch output directory without making GCS part of the core runtime. */
export async function uploadResultsDirectory(
  outputDir: string,
  destination: string
): Promise<void> {
  const { bucket: bucketName, prefix } = parseGcsUri(destination);
  let storage: GCSModule;
  try {
    storage = (await import('@google-cloud/storage')) as unknown as GCSModule;
  } catch (error) {
    throw new Error(
      'GCS result upload requires the optional `@google-cloud/storage` package. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const bucket = new storage.Storage().bucket(bucketName);
  for (const relative of await filesUnder(outputDir)) {
    const objectName = [prefix, relative].filter(Boolean).join('/');
    await bucket.file(objectName).save(await fs.readFile(path.join(outputDir, relative)), {
      resumable: false,
    });
  }
}
