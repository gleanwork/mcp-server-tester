export type {
  StoredTokens,
  StoredClientInfo,
  StoredOAuthState,
  OAuthSetupConfig,
  TokenResult,
} from '../auth/types.js';

export type { PlaywrightOAuthClientProviderConfig } from '../auth/oauthClientProvider.js';

export type {
  AuthServerMetadata,
  PKCEPair,
  AuthorizationUrlConfig,
  TokenExchangeConfig,
  TokenRefreshConfig,
  ClientCredentialsConfig,
} from '../auth/oauthFlow.js';

export type {
  ProtectedResourceMetadata,
  ProtectedResourceDiscoveryResult,
} from '../auth/discovery.js';

export type {
  StoredServerMetadata,
  OAuthStorage,
  FileOAuthStorageConfig,
  KnownServer,
} from '../auth/storage.js';

export type { CLIOAuthClientConfig, CLIOAuthResult } from '../auth/cli.js';
