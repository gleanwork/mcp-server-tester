/**
 * @gleanwork/mcp-server-tester/auth
 *
 * Low-level OAuth: RFC 9728 discovery, token storage, and the
 * client-credentials flow. The documented helpers
 * (PlaywrightOAuthClientProvider, CLIOAuthClient, token headers and OAuth
 * setup) stay in the root.
 *
 * @packageDocumentation
 */

export type {
  StoredClientInfo,
  StoredOAuthState,
  ClientCredentialsConfig,
  ProtectedResourceMetadata,
  ProtectedResourceDiscoveryResult,
  StoredServerMetadata,
} from '../types/index.js';
export { performClientCredentialsFlow } from '../auth/oauthFlow.js';
export {
  discoverProtectedResource,
  discoverAuthorizationServer,
  DiscoveryError,
  MCP_PROTOCOL_VERSION,
} from '../auth/discovery.js';
export {
  loadTokens,
  hasValidTokens,
  loadTokensFromEnv,
  ENV_VAR_NAMES,
} from '../auth/storage.js';
