import { recoverMacCoworkSession } from '../src/evals/coworkSetup/recoverSession.js';

if (process.argv[2] !== '--confirm') {
  console.error(
    'Explicit recovery requires --confirm. This restores only hash-verified MST settings after the prior owner has stopped.'
  );
  process.exitCode = 2;
} else {
  try {
    await recoverMacCoworkSession();
    console.log(
      'Previous MST Cowork settings restored; recovery lease released.'
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Cowork recovery failed; state retained.'
    );
    process.exitCode = 1;
  }
}
