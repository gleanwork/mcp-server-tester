/** The error a judge adapter throws when its optional SDK isn't installed. */
export function missingJudgePackage(
  judge: string,
  packageName: string,
  cause: unknown
): Error {
  return new Error(
    `${judge} judge requires the \`${packageName}\` package. ` +
      `Install it with: npm install ${packageName}\n` +
      `Original error: ${cause instanceof Error ? cause.message : String(cause)}`
  );
}

/** Reads the API key a judge needs, or throws naming the variable to set. */
export function requireJudgeApiKey(judge: string, envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey)
    throw new Error(
      `${judge} judge requires an API key. Set the ${envVar} environment variable.`
    );
  return apiKey;
}
