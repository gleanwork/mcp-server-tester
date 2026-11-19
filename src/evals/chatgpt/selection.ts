import type { ChatgptAppConfig } from './config.js';

export function selectedChatgptServerLabels(
  labels: readonly string[],
  firstParty?: ChatgptAppConfig['firstParty']
): Set<string> {
  return new Set([
    ...labels,
    ...(firstParty && 'serverName' in firstParty
      ? [firstParty.serverName]
      : []),
  ]);
}
