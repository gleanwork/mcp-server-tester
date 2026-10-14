/**
 * The optional `@google-cloud/storage` package's `Storage` client, loaded on
 * first use so MST doesn't need it unless a store writes to GCS. `B` is the
 * part of a bucket's API the caller uses.
 */
export async function loadGCSStorage<B>(): Promise<{
  bucket(name: string): B;
}> {
  const moduleName = '@google-cloud/storage';
  try {
    const mod = (await import(moduleName)) as {
      Storage: new () => { bucket(name: string): B };
    };
    return new mod.Storage();
  } catch (error) {
    throw new Error(
      'GCS result storage requires the optional `@google-cloud/storage` package. ' +
        'Install it and authenticate with Application Default Credentials via GOOGLE_APPLICATION_CREDENTIALS.\n' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
