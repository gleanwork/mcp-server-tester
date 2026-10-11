// Claude Desktop's base managed settings: third-party inference through an
// LLM gateway, with a credential helper that reads the token MST delivers.
// MST's owned-desktop mode keeps these keys and writes each variant's
// servers and model over them.
const env = process.env;
const models = (env.MST_INFERENCE_MODELS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const settings = {
  inferenceProvider: 'gateway',
  inferenceGatewayBaseUrl: env.MST_INFERENCE_GATEWAY_URL,
  inferenceGatewayAuthScheme: env.MST_INFERENCE_AUTH_SCHEME || 'bearer',
  inferenceCredentialKind: 'helper-script',
  inferenceCredentialHelper: '/opt/mst/bin/inference-token',
  inferenceCredentialHelperTtlSec: '300',
  inferenceCredentialHelperTimeoutSec: '15',
  disableDeploymentModeChooser: 'true',
  modelDiscoveryEnabled: 'false',
  deploymentDisplayName: 'MST',
  ...(models.length ? { inferenceModels: models.map((name) => ({ name })) } : {}),
  disabledBuiltinTools: ['AskUserQuestion'],
};
process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
