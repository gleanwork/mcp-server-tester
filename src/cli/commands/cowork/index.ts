import { initializeMacCoworkProfile } from '../../../evals/coworkSetup/macTransaction.js';

export async function setupCowork(): Promise<void> {
  const result = await initializeMacCoworkProfile();
  if (result.created) {
    console.log(
      `Initialized the empty Claude 3P profile at ${result.profileDirectory}.`
    );
    console.log(
      'Next: launch Claude Desktop, sign in, open one normal conversation, quit Claude Desktop, then run the Cowork evaluation.'
    );
  } else {
    console.log(`Claude 3P profile is ready at ${result.profileDirectory}.`);
    console.log(
      'If Claude Desktop is not signed in, launch it and complete sign-in before running the Cowork evaluation.'
    );
  }
}
