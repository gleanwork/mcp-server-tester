import type { CoworkSetupConfig } from './coworkSetup/options.js';
import type { CoworkMcpServerConfig } from './coworkSetup/config.js';

export interface EvalManifestArm {
  name: string;
  servers?: CoworkMcpServerConfig[];
  coworkSetup?: CoworkSetupConfig;
}

/** Minimal manifest shape required by the managed Cowork setup lifecycle. */
export interface EvalManifest {
  name: string;
  datasets: unknown[];
  servers?: CoworkMcpServerConfig[];
  arms?: EvalManifestArm[];
  coworkSetup?: CoworkSetupConfig;
}
