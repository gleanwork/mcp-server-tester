import type {
  ExternalClientType,
  ClientDriverConfig,
  ClientDriverId,
} from './types.js';

export const OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER: ClientDriverId = {
  provider: 'openai',
  product: 'chatgpt',
  surface: 'agent',
  runtime: 'desktop-app',
  platform: 'macos',
};

export const OPENAI_CHATGPT_AGENT_DESKTOP_LINUX_DRIVER: ClientDriverId = {
  ...OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER,
  platform: 'linux',
};

export function driverToSlug(driver: ClientDriverId): string {
  return [
    driver.provider,
    driver.product,
    driver.surface,
    driver.runtime,
    driver.platform,
    driver.channel,
  ]
    .filter((part): part is string => Boolean(part))
    .join('.');
}

function parseDriverSlug(slug: string): ClientDriverId {
  const [provider, product, surface, runtime, platform, ...rest] =
    slug.split('.');

  if (!provider || !product || !surface || !runtime) {
    throw new Error(
      `External client driver slug must include provider.product.surface.runtime: ${slug}`
    );
  }

  return {
    provider,
    product,
    surface,
    runtime,
    ...(platform ? { platform } : {}),
    ...(rest.length > 0 ? { channel: rest.join('.') } : {}),
  };
}

export function normalizeClientDriver(
  driver: ClientDriverConfig
): ClientDriverId {
  if (typeof driver === 'string') {
    return parseDriverSlug(driver);
  }

  return driver;
}

export function clientTypeFromDriver(
  driver: ClientDriverId
): ExternalClientType {
  if (driver.runtime === 'cli' || driver.runtime === 'tui') return 'cli';
  if (driver.runtime === 'browser') return 'browser';
  if (driver.runtime === 'desktop-app') return 'desktop';
  return 'custom';
}
