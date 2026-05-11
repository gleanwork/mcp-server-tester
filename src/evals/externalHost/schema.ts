import { z } from 'zod';
import {
  getRegisteredExternalHostConfig,
  getRegisteredExternalHostDescription,
  listRegisteredExternalHostSlugs,
} from './hostRegistry.js';
import { driverToSlug, normalizeHostDriver } from './driverIdentity.js';
import type {
  ExternalHostCapabilitiesConfig,
  ExternalHostConfig,
  HostDriverId,
} from './types.js';

export const HostDriverIdSchema = z.object({
  provider: z.string().min(1),
  product: z.string().min(1),
  surface: z.string().min(1),
  runtime: z.string().min(1),
  platform: z.string().optional(),
  channel: z.string().optional(),
});

export const HostCapabilitySchema = z.enum([
  'control',
  'input',
  'completion',
  'trace',
  'normalize',
]);

export const ExternalHostCapabilityBindingSchema = z.object({
  uses: z.string().min(1),
  with: z.record(z.string(), z.unknown()).optional(),
  provides: z.array(HostCapabilitySchema).optional(),
});

export const ExternalHostCorrelationSchema = z.object({
  strategy: z
    .enum(['prompt_marker', 'host_session_metadata', 'none'])
    .optional(),
  includeInPrompt: z.boolean().optional(),
  promptTemplate: z.string().optional(),
});

export const ExternalHostConfigSchema = z.object({
  driver: z.union([HostDriverIdSchema, z.string().min(1)]),
  name: z.string().optional(),
  hostType: z.enum(['cli', 'browser', 'desktop', 'custom']).optional(),
  variant: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  capabilities: z
    .partialRecord(
      HostCapabilitySchema,
      z.union([
        ExternalHostCapabilityBindingSchema,
        z.array(ExternalHostCapabilityBindingSchema),
      ])
    )
    .optional(),
  correlation: ExternalHostCorrelationSchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export interface ExternalHostDriverReference {
  slug: string;
  driver: HostDriverId;
  name: string;
  description?: string;
  builtIn: true;
  defaultConfig: ExternalHostConfig;
  capabilities?: ExternalHostCapabilitiesConfig;
  example: {
    mode: 'external_host';
    scenario: string;
    externalHost: Pick<ExternalHostConfig, 'driver' | 'timeoutMs'>;
    expect: { containsText: string };
  };
}

export function listExternalHostDriverReferences(): ExternalHostDriverReference[] {
  return listRegisteredExternalHostSlugs().map((slug) => {
    const config = getRegisteredExternalHostConfig(slug);
    const driver = normalizeHostDriver(slug);
    const name = config?.name ?? slug;

    return {
      slug,
      driver,
      name,
      description: getRegisteredExternalHostDescription(slug),
      builtIn: true,
      defaultConfig: {
        driver,
        ...(config ?? {}),
      },
      capabilities: config?.capabilities,
      example: {
        mode: 'external_host',
        scenario: 'Ask the host to complete the task you want to evaluate.',
        externalHost: {
          driver: slug,
          timeoutMs: config?.timeoutMs ?? 60_000,
        },
        expect: {
          containsText: 'expected text',
        },
      },
    };
  });
}

export function getExternalHostConfigJsonSchema(): Record<string, unknown> {
  const driverSlugs = listRegisteredExternalHostSlugs();

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/gleanwork/mcp-server-tester/schemas/external-host-config.schema.json',
    title: 'MCP Server Tester ExternalHostConfig',
    description:
      'Configuration for running an MCP eval through an external host driver.',
    type: 'object',
    additionalProperties: false,
    required: ['driver'],
    properties: {
      driver: {
        description:
          'Canonical built-in driver slug, custom driver slug, or structured driver identity.',
        anyOf: [
          {
            type: 'string',
            enum: driverSlugs,
            description:
              'Known built-in driver slug. Prefer this form for normal eval datasets.',
          },
          {
            type: 'string',
            minLength: 1,
            description:
              'Custom driver slug. Use when registering project-local capabilities.',
          },
          hostDriverIdJsonSchema(),
        ],
      },
      name: {
        type: 'string',
        description: 'Optional display name shown in reports.',
      },
      hostType: {
        type: 'string',
        enum: ['cli', 'browser', 'desktop', 'custom'],
        description: 'Host category shown in reports.',
      },
      variant: {
        type: 'string',
        description: 'Optional variant label for matrix-style runs.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'End-to-end timeout for the host run in milliseconds.',
      },
      correlation: externalHostCorrelationJsonSchema(),
      options: {
        type: 'object',
        additionalProperties: true,
        description:
          'Driver-wide options interpreted by the selected driver or capability bindings.',
      },
      capabilities: externalHostCapabilitiesJsonSchema(),
    },
    examples: listExternalHostDriverReferences().map((reference) => ({
      driver: reference.slug,
      timeoutMs: reference.example.externalHost.timeoutMs,
    })),
  };
}

export function getExternalHostReference(): Record<string, unknown> {
  return {
    schema: getExternalHostConfigJsonSchema(),
    drivers: listExternalHostDriverReferences(),
  };
}

function hostDriverIdJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'product', 'surface', 'runtime'],
    properties: {
      provider: { type: 'string', minLength: 1 },
      product: { type: 'string', minLength: 1 },
      surface: { type: 'string', minLength: 1 },
      runtime: { type: 'string', minLength: 1 },
      platform: { type: 'string' },
      channel: { type: 'string' },
    },
  };
}

function externalHostCorrelationJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    description:
      'How a submitted host run is correlated with host-native trace evidence.',
    properties: {
      strategy: {
        type: 'string',
        enum: ['prompt_marker', 'host_session_metadata', 'none'],
      },
      includeInPrompt: {
        type: 'boolean',
        description:
          'Whether to include the generated run marker in the host-visible prompt.',
      },
      promptTemplate: {
        type: 'string',
        description: 'Prompt suffix template. Supports {{marker}}.',
      },
    },
  };
}

function externalHostCapabilitiesJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    description:
      'Advanced escape hatch for overriding the capability recipe. Most users should choose a built-in driver instead.',
    properties: Object.fromEntries(
      HostCapabilitySchema.options.map((capability) => [
        capability,
        {
          anyOf: [
            externalHostCapabilityBindingJsonSchema(),
            {
              type: 'array',
              items: externalHostCapabilityBindingJsonSchema(),
            },
          ],
        },
      ])
    ),
  };
}

function externalHostCapabilityBindingJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['uses'],
    properties: {
      uses: {
        type: 'string',
        minLength: 1,
        description:
          'Capability implementation id. Built-ins use builtin:<id>; custom integrations may use module:<specifier>#<export>.',
      },
      with: {
        type: 'object',
        additionalProperties: true,
        description:
          'Binding-local options interpreted by the selected capability implementation.',
      },
      provides: {
        type: 'array',
        items: {
          type: 'string',
          enum: HostCapabilitySchema.options,
        },
      },
    },
  };
}

export function externalHostDriverSlugForConfig(
  config: ExternalHostConfig
): string {
  return driverToSlug(normalizeHostDriver(config.driver));
}
