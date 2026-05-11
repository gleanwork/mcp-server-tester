import type {
  ExternalHostType,
  HostDriverConfig,
  HostDriverId,
} from './types.js';

export const CLAUDE_CHAT_DESKTOP_MACOS_DRIVER: HostDriverId = {
  provider: 'anthropic',
  product: 'claude',
  surface: 'chat',
  runtime: 'desktop-app',
  platform: 'macos',
};

export const CLAUDE_COWORK_DESKTOP_MACOS_DRIVER: HostDriverId = {
  provider: 'anthropic',
  product: 'claude',
  surface: 'cowork',
  runtime: 'desktop-app',
  platform: 'macos',
};

export const CLAUDE_CODE_CLI_MACOS_DRIVER: HostDriverId = {
  provider: 'anthropic',
  product: 'claude',
  surface: 'code',
  runtime: 'cli',
  platform: 'macos',
};

export function driverToSlug(driver: HostDriverId): string {
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

export function parseDriverSlug(slug: string): HostDriverId {
  const [provider, product, surface, runtime, platform, ...rest] =
    slug.split('.');

  if (!provider || !product || !surface || !runtime) {
    throw new Error(
      `External host driver slug must include provider.product.surface.runtime: ${slug}`
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

export function normalizeHostDriver(driver: HostDriverConfig): HostDriverId {
  if (typeof driver === 'string') {
    return parseDriverSlug(driver);
  }

  return driver;
}

export function hostTypeFromDriver(driver: HostDriverId): ExternalHostType {
  if (driver.runtime === 'cli' || driver.runtime === 'tui') return 'cli';
  if (driver.runtime === 'browser') return 'browser';
  if (driver.runtime === 'desktop-app') return 'desktop';
  return 'custom';
}
