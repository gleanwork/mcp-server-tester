import { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { StatusMessage } from '../../components/index.js';
import {
  createFileOAuthStorage,
  ENV_VAR_NAMES,
  getStateDir,
} from '../../../auth/storage.js';

type TokenFormat = 'env' | 'json' | 'gh';

export interface TokenOptions {
  format?: TokenFormat;
  stateDir?: string;
}

interface TokenAppProps {
  serverUrl: string;
  options: TokenOptions;
}

type Step = 'loading' | 'success' | 'error';

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
}

export function TokenApp({ serverUrl, options }: TokenAppProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('loading');
  const [tokens, setTokens] = useState<TokenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateDir, setStateDir] = useState<string>('');

  useEffect(() => {
    async function loadTokens() {
      try {
        new URL(serverUrl);
      } catch {
        setError(`Invalid URL: ${serverUrl}`);
        setStep('error');
        return;
      }

      const storage = createFileOAuthStorage({
        serverUrl,
        stateDir: options.stateDir,
      });

      const loadedTokens = await storage.loadTokens();

      if (!loadedTokens) {
        setStateDir(getStateDir(serverUrl, options.stateDir));
        setError('No tokens found');
        setStep('error');
        return;
      }

      setTokens(loadedTokens);
      setStep('success');
    }

    loadTokens();
  }, [serverUrl, options.stateDir]);

  useEffect(() => {
    if (step === 'success' || step === 'error') {
      exit();
    }
  }, [step, exit]);

  const format = options.format ?? 'env';

  if (step === 'loading') {
    return null;
  }

  if (step === 'error') {
    if (error === 'No tokens found') {
      return (
        <Box flexDirection="column" padding={1}>
          <StatusMessage status="error">
            No tokens found for {serverUrl}
          </StatusMessage>
          <Text dimColor>Expected location: {stateDir}/tokens.json</Text>
          <Text> </Text>
          <Text dimColor>
            Run &apos;mcp-server-tester login {serverUrl}&apos; to authenticate
            first.
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" padding={1}>
        <StatusMessage status="error">{error}</StatusMessage>
      </Box>
    );
  }

  if (step === 'success' && tokens) {
    switch (format) {
      case 'env':
        return <EnvFormat tokens={tokens} />;
      case 'json':
        return <JsonFormat tokens={tokens} />;
      case 'gh':
        return <GhFormat tokens={tokens} />;
    }
  }

  return null;
}

/**
 * Output tokens as KEY=value pairs (shell-compatible)
 */
function EnvFormat({ tokens }: { tokens: TokenData }) {
  return (
    <Box flexDirection="column">
      <Text>
        {ENV_VAR_NAMES.accessToken}={tokens.accessToken}
      </Text>
      {tokens.refreshToken && (
        <Text>
          {ENV_VAR_NAMES.refreshToken}={tokens.refreshToken}
        </Text>
      )}
      <Text>
        {ENV_VAR_NAMES.tokenType}={tokens.tokenType}
      </Text>
      {tokens.expiresAt && (
        <Text>
          {ENV_VAR_NAMES.expiresAt}={tokens.expiresAt}
        </Text>
      )}
    </Box>
  );
}

/**
 * Output tokens as JSON
 */
function JsonFormat({ tokens }: { tokens: TokenData }) {
  const output: Record<string, string | number> = {
    [ENV_VAR_NAMES.accessToken]: tokens.accessToken,
    [ENV_VAR_NAMES.tokenType]: tokens.tokenType,
  };

  if (tokens.refreshToken) {
    output[ENV_VAR_NAMES.refreshToken] = tokens.refreshToken;
  }

  if (tokens.expiresAt) {
    output[ENV_VAR_NAMES.expiresAt] = tokens.expiresAt;
  }

  return <Text>{JSON.stringify(output, null, 2)}</Text>;
}

/**
 * Output tokens as gh secret set commands
 */
function GhFormat({ tokens }: { tokens: TokenData }) {
  return (
    <Box flexDirection="column">
      <Text dimColor># Run these commands to set GitHub Actions secrets:</Text>
      <Text>
        gh secret set {ENV_VAR_NAMES.accessToken} --body &quot;
        {tokens.accessToken}&quot;
      </Text>
      {tokens.refreshToken && (
        <Text>
          gh secret set {ENV_VAR_NAMES.refreshToken} --body &quot;
          {tokens.refreshToken}&quot;
        </Text>
      )}
      <Text>
        gh secret set {ENV_VAR_NAMES.tokenType} --body &quot;{tokens.tokenType}
        &quot;
      </Text>
      {tokens.expiresAt && (
        <Text>
          gh secret set {ENV_VAR_NAMES.expiresAt} --body &quot;
          {tokens.expiresAt}&quot;
        </Text>
      )}
    </Box>
  );
}
