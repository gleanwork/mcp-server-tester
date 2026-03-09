import type { OAuthSetupConfig } from '@gleanwork/mcp-server-tester';

type LoginSelectors = OAuthSetupConfig['loginSelectors'];

const idpSelectors: Record<string, LoginSelectors> = {
  okta: {
    usernameInput: '#okta-signin-username',
    passwordInput: '#okta-signin-password',
    submitButton: '#okta-signin-submit',
  },
  auth0: {
    usernameInput: 'input[name="email"]',
    passwordInput: 'input[name="password"]',
    submitButton: 'button[type="submit"]',
  },
  azureAd: {
    usernameInput: 'input[name="loginfmt"]',
    passwordInput: 'input[name="passwd"]',
    submitButton: 'input[type="submit"]',
  },
  google: {
    usernameInput: 'input[type="email"]',
    passwordInput: 'input[type="password"]',
    submitButton: '#passwordNext',
  },
};

export function getIdpSelectors(provider: string): LoginSelectors {
  const selectors = idpSelectors[provider];
  if (!selectors) {
    throw new Error(
      `Unknown IdP provider: ${provider}. Known providers: ${Object.keys(idpSelectors).join(', ')}`
    );
  }
  return selectors;
}
