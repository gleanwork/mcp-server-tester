import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Select, TextInput, ConfirmInput } from '@inkjs/ui';
import type { Client } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { Spinner, StatusMessage, JsonPreview } from '../../components/index.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../../../mcp/clientFactory.js';
import {
  type MCPConfig,
  validateMCPConfig,
  isHttpConfig,
} from '../../../config/mcpConfig.js';
import { listKnownServers, type KnownServer } from '../../../auth/storage.js';
import { CLIOAuthClient } from '../../../auth/cli.js';
import type {
  EvalDataset,
  EvalCase,
  SerializedEvalDataset,
} from '../../../evals/datasetTypes.js';
import { suggestExpectations } from '../../utils/expectationSuggester.js';
import { writeFile, readFile, stat, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';

type Step =
  | 'loadingServers'
  | 'selectServer'
  | 'configTransport'
  | 'configStdio'
  | 'configHttp'
  | 'connecting'
  | 'authRequired'
  | 'datasetName'
  | 'appendPrompt'
  | 'selectTool'
  | 'enterArgField'
  | 'enterRawArgs'
  | 'callingTool'
  | 'reviewResponse'
  | 'caseId'
  | 'caseDescription'
  | 'useTextContains'
  | 'useRegex'
  | 'useExact'
  | 'useSnapshot'
  | 'askContinue'
  | 'saving'
  | 'done'
  | 'error';

/**
 * Schema property for form generation
 */
interface SchemaProperty {
  name: string;
  type: string;
  description?: string;
  required: boolean;
}

/**
 * Check if an error indicates authentication is required
 */
function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('401') ||
    message.includes('Authorization') ||
    message.includes('Unauthorized') ||
    message.includes('authentication required')
  );
}

export interface GenerateOptions {
  config?: string;
  output?: string;
  snapshot?: boolean;
}

interface GenerateAppProps {
  options: GenerateOptions;
}

export function GenerateApp({ options }: GenerateAppProps) {
  const { exit } = useApp();

  // State machine - start by loading known servers if no config provided
  const [step, setStep] = useState<Step>(
    options.config ? 'connecting' : 'loadingServers'
  );

  // Known servers state
  const [knownServers, setKnownServers] = useState<KnownServer[]>([]);

  // Configuration state
  const [mcpConfig, setMcpConfig] = useState<MCPConfig | null>(null);

  // MCP state
  const [client, setClient] = useState<Client | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [response, setResponse] = useState<unknown>(null);
  const [callError, setCallError] = useState<string | null>(null);

  // Schema form state
  const [schemaProperties, setSchemaProperties] = useState<SchemaProperty[]>(
    []
  );
  const [currentPropertyIndex, setCurrentPropertyIndex] = useState(0);
  const [argValues, setArgValues] = useState<Record<string, unknown>>({});

  // Dataset state
  const [dataset, setDataset] = useState<EvalDataset>({
    name: 'my-mcp-evals',
    description: 'Generated eval dataset',
    cases: [],
  });
  const [outputPath] = useState(resolve(options.output || 'data/dataset.json'));

  // Current case state
  const [currentCase, setCurrentCase] = useState<Partial<EvalCase>>({});
  const [suggestions, setSuggestions] = useState<{
    textContains: string[];
    regex: string[];
  }>({ textContains: [], regex: [] });

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Track mounted state for async cleanup
  const isMountedRef = useRef(true);

  // Load known servers on mount
  useEffect(() => {
    if (step === 'loadingServers') {
      loadKnownServers();
    }

    async function loadKnownServers() {
      const servers = await listKnownServers();
      const authenticatedServers = servers.filter((s) => s.hasTokens);
      setKnownServers(authenticatedServers);

      if (authenticatedServers.length > 0) {
        setStep('selectServer');
      } else {
        setStep('configTransport');
      }
    }
  }, [step]);

  // Load config if provided
  useEffect(() => {
    if (options.config) {
      loadConfig(options.config);
    }
  }, [options.config]);

  async function loadConfig(configPath: string) {
    try {
      const content = await readFile(resolve(configPath), 'utf-8');
      const config = JSON.parse(content);
      setMcpConfig(validateMCPConfig(config));
      setStep('connecting');
    } catch (err) {
      setError(
        `Failed to load config: ${err instanceof Error ? err.message : String(err)}`
      );
      setStep('error');
    }
  }

  // Connect when we have config
  useEffect(() => {
    if (step === 'connecting' && mcpConfig) {
      connectToServer();
    }

    async function connectToServer() {
      if (!mcpConfig) return;

      try {
        // For HTTP configs, get a valid OAuth token (with automatic refresh)
        let configWithAuth = mcpConfig;
        if (isHttpConfig(mcpConfig)) {
          const oauthClient = new CLIOAuthClient({
            mcpServerUrl: mcpConfig.serverUrl,
          });
          const tokenResult = await oauthClient.tryGetAccessToken();

          if (tokenResult) {
            configWithAuth = {
              ...mcpConfig,
              auth: { accessToken: tokenResult.accessToken },
            };
          }
          // If no token available, try to connect anyway - server may not require auth
        }

        const c = await createMCPClientForConfig(configWithAuth);

        // Check if still mounted before updating state
        if (!isMountedRef.current) {
          await closeMCPClient(c);
          return;
        }

        const result = await c.listTools();

        if (!isMountedRef.current) {
          await closeMCPClient(c);
          return;
        }

        setClient(c);
        setTools(result.tools || []);

        // Check if output file exists
        let fileExists = false;
        try {
          await stat(outputPath);
          fileExists = true;
        } catch {
          // File doesn't exist
        }

        if (fileExists) {
          setStep('appendPrompt');
        } else {
          setStep('datasetName');
        }
      } catch (err) {
        if (isMountedRef.current) {
          if (isAuthError(err)) {
            setStep('authRequired');
          } else {
            setError(
              `Failed to connect: ${err instanceof Error ? err.message : String(err)}`
            );
            setStep('error');
          }
        }
      }
    }
  }, [step, mcpConfig, outputPath]);

  async function callTool(finalArgs: Record<string, unknown>) {
    if (!client || !selectedTool) return;

    try {
      const result = await client.callTool({
        name: selectedTool.name,
        arguments: finalArgs,
      });
      const responseData = result.structuredContent ?? result.content;
      setResponse(responseData);
      setCallError(null);

      // Get suggestions
      const sugg = suggestExpectations(responseData, selectedTool);
      setSuggestions(sugg);

      // Initialize current case
      setCurrentCase({
        toolName: selectedTool.name,
        args: finalArgs,
      });

      setStep('reviewResponse');
    } catch (err) {
      setCallError(err instanceof Error ? err.message : String(err));
      setStep('reviewResponse');
    }
  }

  async function saveDataset() {
    try {
      // Note: We use the EvalDataset type for building, then serialize.
      // The CLI only creates string patterns, so this is JSON-safe.
      const serialized = {
        name: dataset.name,
        description: dataset.description,
        cases: dataset.cases,
        metadata: {
          version: '1.0',
          created: new Date().toISOString().split('T')[0],
        },
      };

      // Create directory if it doesn't exist
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(serialized, null, 2));
      setStep('done');
    } catch (err) {
      setError(
        `Failed to save: ${err instanceof Error ? err.message : String(err)}`
      );
      setStep('error');
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (client) {
        closeMCPClient(client).catch(() => {});
      }
    };
  }, [client]);

  const handleExit = useCallback(() => {
    if (client) {
      closeMCPClient(client)
        .then(() => exit())
        .catch(() => exit());
    } else {
      exit();
    }
  }, [client, exit]);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      handleExit();
    }
  });

  // Exit after rendering done/error/authRequired
  useEffect(() => {
    if (step === 'done' || step === 'error' || step === 'authRequired') {
      handleExit();
    }
  }, [step, handleExit]);

  // Handle step transitions when suggestions are empty (instead of setState in render)
  useEffect(() => {
    if (step === 'useTextContains' && suggestions.textContains.length === 0) {
      setStep('useRegex');
    }
  }, [step, suggestions.textContains.length]);

  useEffect(() => {
    if (step === 'useRegex' && suggestions.regex.length === 0) {
      setStep('useExact');
    }
  }, [step, suggestions.regex.length]);

  // Render based on step
  return (
    <Box flexDirection="column" padding={1}>
      {/* Loading known servers */}
      {step === 'loadingServers' && (
        <Spinner label="Loading known servers..." />
      )}

      {/* Select from known servers */}
      {step === 'selectServer' && (
        <Box flexDirection="column">
          <Text>Select MCP server:</Text>
          <Select
            visibleOptionCount={10}
            options={[
              ...knownServers.map((s) => ({
                label: s.url,
                value: s.url,
              })),
              { label: 'Other (configure manually)', value: '__other__' },
            ]}
            onChange={(value) => {
              if (value === '__other__') {
                setStep('configTransport');
              } else {
                // Use the selected server URL
                setMcpConfig(
                  validateMCPConfig({
                    transport: 'http',
                    serverUrl: value,
                    capabilities: { roots: { listChanged: true } },
                  })
                );
                setStep('connecting');
              }
            }}
          />
        </Box>
      )}

      {/* Transport Selection */}
      {step === 'configTransport' && (
        <Box flexDirection="column">
          <Text>Select MCP transport type:</Text>
          <Select
            options={[
              { label: 'stdio (local server process)', value: 'stdio' },
              { label: 'http (remote server)', value: 'http' },
            ]}
            onChange={(value) => {
              setStep(value === 'stdio' ? 'configStdio' : 'configHttp');
            }}
          />
        </Box>
      )}

      {/* Stdio config */}
      {step === 'configStdio' && (
        <Box flexDirection="column">
          <Text>Server command (e.g., node server.js):</Text>
          <TextInput
            defaultValue="node server.js"
            onSubmit={(value) => {
              const [command, ...cmdArgs] = value.split(' ');
              setMcpConfig(
                validateMCPConfig({
                  transport: 'stdio',
                  command,
                  args: cmdArgs,
                  capabilities: { roots: { listChanged: true } },
                })
              );
              setStep('connecting');
            }}
          />
        </Box>
      )}

      {/* HTTP config */}
      {step === 'configHttp' && (
        <Box flexDirection="column">
          <Text>Server URL:</Text>
          <TextInput
            defaultValue="http://localhost:3000/mcp"
            onSubmit={(value) => {
              setMcpConfig(
                validateMCPConfig({
                  transport: 'http',
                  serverUrl: value,
                  capabilities: { roots: { listChanged: true } },
                })
              );
              setStep('connecting');
            }}
          />
        </Box>
      )}

      {/* Connecting */}
      {step === 'connecting' && <Spinner label="Connecting to MCP server..." />}

      {/* Auth Required */}
      {step === 'authRequired' && mcpConfig && (
        <Box flexDirection="column">
          <StatusMessage status="error">Authentication required</StatusMessage>
          <Text> </Text>
          <Text>This server requires OAuth authentication.</Text>
          {'serverUrl' in mcpConfig && (
            <>
              <Text>
                Run:{' '}
                <Text color="cyan">
                  mcp-server-tester login {mcpConfig.serverUrl}
                </Text>
              </Text>
              <Text> </Text>
              <Text dimColor>Then retry: mcp-server-tester generate</Text>
            </>
          )}
          {'command' in mcpConfig && (
            <Text dimColor>
              Note: stdio servers typically don&apos;t require OAuth
              authentication.
            </Text>
          )}
        </Box>
      )}

      {/* Append prompt */}
      {step === 'appendPrompt' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Connected! Found {tools.length} tools
          </StatusMessage>
          <Text> </Text>
          <Text>Dataset file exists at {outputPath}. Append to it?</Text>
          <ConfirmInput
            onConfirm={async () => {
              try {
                const content = await readFile(outputPath, 'utf-8');
                const existing = JSON.parse(content) as SerializedEvalDataset;
                setDataset({
                  name: existing.name,
                  description: existing.description,
                  cases: existing.cases,
                  metadata: existing.metadata,
                });
                setStep('selectTool');
              } catch {
                setStep('datasetName');
              }
            }}
            onCancel={() => setStep('datasetName')}
          />
        </Box>
      )}

      {/* Dataset name */}
      {step === 'datasetName' && (
        <Box flexDirection="column">
          {client && (
            <StatusMessage status="success">
              Connected! Found {tools.length} tools
            </StatusMessage>
          )}
          <Text> </Text>
          <Text>Dataset name:</Text>
          <TextInput
            defaultValue="my-mcp-evals"
            onSubmit={(value) => {
              setDataset((d) => ({ ...d, name: value }));
              setStep('selectTool');
            }}
          />
        </Box>
      )}

      {/* Tool selection */}
      {step === 'selectTool' && (
        <Box flexDirection="column">
          <Text dimColor>--- New Test Case ---</Text>
          <Text> </Text>
          <Text>Select tool to test:</Text>
          <Select
            visibleOptionCount={15}
            options={tools.map((t) => ({
              label: t.name,
              value: t.name,
            }))}
            onChange={(value) => {
              const tool = tools.find((t) => t.name === value);
              setSelectedTool(tool || null);

              // Extract schema properties from tool's inputSchema
              if (tool?.inputSchema) {
                const schema = tool.inputSchema as {
                  properties?: Record<
                    string,
                    { type?: string; description?: string }
                  >;
                  required?: string[];
                };
                const props = schema.properties ?? {};
                const required = schema.required ?? [];

                const properties: SchemaProperty[] = Object.entries(props).map(
                  ([name, prop]) => ({
                    name,
                    type: prop.type ?? 'string',
                    description: prop.description,
                    required: required.includes(name),
                  })
                );

                setSchemaProperties(properties);
                setCurrentPropertyIndex(0);
                setArgValues({});

                if (properties.length > 0) {
                  setStep('enterArgField');
                } else {
                  // No properties defined - fall back to raw JSON entry
                  setStep('enterRawArgs');
                }
              } else {
                // No schema - fall back to raw JSON entry
                setSchemaProperties([]);
                setArgValues({});
                setStep('enterRawArgs');
              }
            }}
          />
        </Box>
      )}

      {/* Argument Field Entry */}
      {step === 'enterArgField' && schemaProperties.length > 0 && (
        <Box flexDirection="column">
          {(() => {
            const prop = schemaProperties[currentPropertyIndex];
            if (!prop) return null;

            return (
              <>
                <Text dimColor>
                  Field {currentPropertyIndex + 1} of {schemaProperties.length}
                </Text>
                <Text>
                  <Text bold>{prop.name}</Text>
                  <Text dimColor> ({prop.type})</Text>
                  {prop.required && <Text color="red">*</Text>}
                </Text>
                {prop.description && <Text dimColor>{prop.description}</Text>}
                <TextInput
                  key={prop.name}
                  defaultValue=""
                  onSubmit={(value) => {
                    // Don't allow empty values for required fields
                    if (prop.required && value.trim() === '') {
                      return; // Stay on this field
                    }

                    // Parse value based on type
                    let parsedValue: unknown = value;
                    if (prop.type === 'number' || prop.type === 'integer') {
                      parsedValue = value === '' ? undefined : Number(value);
                    } else if (prop.type === 'boolean') {
                      parsedValue = value.toLowerCase() === 'true';
                    } else if (
                      prop.type === 'array' ||
                      prop.type === 'object'
                    ) {
                      try {
                        parsedValue =
                          value === '' ? undefined : JSON.parse(value);
                      } catch {
                        parsedValue = value;
                      }
                    } else {
                      parsedValue = value === '' ? undefined : value;
                    }

                    // Build final arg values (skip undefined for optional fields)
                    const finalArgs = { ...argValues };
                    if (parsedValue !== undefined) {
                      finalArgs[prop.name] = parsedValue;
                    }
                    setArgValues(finalArgs);

                    // Move to next property or call tool
                    if (currentPropertyIndex < schemaProperties.length - 1) {
                      setCurrentPropertyIndex(currentPropertyIndex + 1);
                    } else {
                      // Pass finalArgs directly to avoid stale state
                      setStep('callingTool');
                      setTimeout(() => callTool(finalArgs), 0);
                    }
                  }}
                />
              </>
            );
          })()}
        </Box>
      )}

      {/* Raw JSON Args Entry (fallback when no schema properties) */}
      {step === 'enterRawArgs' && (
        <Box flexDirection="column">
          <Text>Tool arguments (JSON):</Text>
          {selectedTool?.description && (
            <Text dimColor>{selectedTool.description}</Text>
          )}
          <TextInput
            defaultValue="{}"
            onSubmit={(value) => {
              try {
                const parsed = JSON.parse(value) as Record<string, unknown>;
                setArgValues(parsed);
                setStep('callingTool');
                // Pass parsed args directly to avoid stale state
                setTimeout(() => callTool(parsed), 0);
              } catch {
                // Invalid JSON, stay on this step
              }
            }}
          />
        </Box>
      )}

      {/* Calling tool */}
      {step === 'callingTool' && (
        <Spinner label={`Calling ${selectedTool?.name}...`} />
      )}

      {/* Review response */}
      {step === 'reviewResponse' && (
        <Box flexDirection="column">
          {callError ? (
            <StatusMessage status="error">
              Tool call failed: {callError}
            </StatusMessage>
          ) : (
            <>
              <StatusMessage status="success">
                Tool called successfully
              </StatusMessage>
              <Text> </Text>
              <Text dimColor>Response preview:</Text>
              <JsonPreview data={response} maxLines={10} />
              {suggestions.textContains.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="cyan">Suggested expectations:</Text>
                  <Text dimColor>
                    Text contains:{' '}
                    {suggestions.textContains.map((t) => `"${t}"`).join(', ')}
                  </Text>
                </Box>
              )}
            </>
          )}
          <Text> </Text>
          <Text>Press Enter to continue...</Text>
          <TextInput
            defaultValue=""
            onSubmit={() => {
              if (callError) {
                setStep('askContinue');
              } else {
                setStep('caseId');
              }
            }}
          />
        </Box>
      )}

      {/* Case ID */}
      {step === 'caseId' && (
        <Box flexDirection="column">
          <Text>Test case ID:</Text>
          <TextInput
            defaultValue={`${selectedTool?.name}-${dataset.cases.length + 1}`}
            onSubmit={(value) => {
              setCurrentCase((c) => ({ ...c, id: value }));
              setStep('caseDescription');
            }}
          />
        </Box>
      )}

      {/* Case description */}
      {step === 'caseDescription' && (
        <Box flexDirection="column">
          <Text>Description (optional, press Enter to skip):</Text>
          <TextInput
            defaultValue=""
            onSubmit={(value) => {
              setCurrentCase((c) => ({
                ...c,
                description: value || undefined,
              }));
              if (options.snapshot) {
                // Skip to adding case with snapshot
                const newCase: EvalCase = {
                  id: currentCase.id!,
                  description: value || undefined,
                  toolName: currentCase.toolName!,
                  args: currentCase.args!,
                  expect: { snapshot: currentCase.id! },
                };
                setDataset((d) => ({ ...d, cases: [...d.cases, newCase] }));
                setStep('askContinue');
              } else {
                setStep('useTextContains');
              }
            }}
          />
        </Box>
      )}

      {/* Use text contains */}
      {step === 'useTextContains' && suggestions.textContains.length > 0 && (
        <Box flexDirection="column">
          <Text>Add text contains expectations?</Text>
          <Text dimColor>
            ({suggestions.textContains.map((t) => `"${t}"`).join(', ')})
          </Text>
          <ConfirmInput
            onConfirm={() => {
              setCurrentCase((c) => ({
                ...c,
                expect: {
                  ...c.expect,
                  containsText: suggestions.textContains,
                },
              }));
              setStep('useRegex');
            }}
            onCancel={() => setStep('useRegex')}
          />
        </Box>
      )}

      {/* Use regex */}
      {step === 'useRegex' && suggestions.regex.length > 0 && (
        <Box flexDirection="column">
          <Text>Add regex expectations?</Text>
          <Text dimColor>
            ({suggestions.regex.map((r) => `/${r}/`).join(', ')})
          </Text>
          <ConfirmInput
            onConfirm={() => {
              setCurrentCase((c) => ({
                ...c,
                expect: {
                  ...c.expect,
                  matchesPattern: suggestions.regex,
                },
              }));
              setStep('useExact');
            }}
            onCancel={() => setStep('useExact')}
          />
        </Box>
      )}

      {/* Use exact match */}
      {step === 'useExact' && (
        <Box flexDirection="column">
          <Text>Add exact match expectation?</Text>
          <ConfirmInput
            onConfirm={() => {
              setCurrentCase((c) => ({
                ...c,
                expect: {
                  ...c.expect,
                  response,
                },
              }));
              setStep('useSnapshot');
            }}
            onCancel={() => setStep('useSnapshot')}
          />
        </Box>
      )}

      {/* Use snapshot */}
      {step === 'useSnapshot' && (
        <Box flexDirection="column">
          <Text>Use Playwright snapshot testing?</Text>
          <ConfirmInput
            onConfirm={() => {
              const newCase: EvalCase = {
                id: currentCase.id!,
                description: currentCase.description,
                toolName: currentCase.toolName!,
                args: currentCase.args!,
                expect: {
                  ...currentCase.expect,
                  snapshot: currentCase.id!,
                },
              };
              setDataset((d) => ({ ...d, cases: [...d.cases, newCase] }));
              setStep('askContinue');
            }}
            onCancel={() => {
              const newCase: EvalCase = {
                id: currentCase.id!,
                description: currentCase.description,
                toolName: currentCase.toolName!,
                args: currentCase.args!,
                expect: currentCase.expect,
              };
              setDataset((d) => ({ ...d, cases: [...d.cases, newCase] }));
              setStep('askContinue');
            }}
          />
        </Box>
      )}

      {/* Ask continue */}
      {step === 'askContinue' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Added test case "{currentCase.id}"
          </StatusMessage>
          <Text>Total cases: {dataset.cases.length}</Text>
          <Text> </Text>
          <Text>Add another test case?</Text>
          <ConfirmInput
            onConfirm={() => {
              setCurrentCase({});
              setSelectedTool(null);
              setSchemaProperties([]);
              setCurrentPropertyIndex(0);
              setArgValues({});
              setResponse(null);
              setCallError(null);
              setSuggestions({ textContains: [], regex: [] });
              setStep('selectTool');
            }}
            onCancel={() => {
              setStep('saving');
              setTimeout(() => saveDataset(), 0);
            }}
          />
        </Box>
      )}

      {/* Saving */}
      {step === 'saving' && <Spinner label="Saving dataset..." />}

      {/* Done */}
      {step === 'done' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Dataset generation complete!
          </StatusMessage>
          <Text> </Text>
          <Text color="cyan">Total test cases: {dataset.cases.length}</Text>
          <Text dimColor>Output: {outputPath}</Text>
          <Text> </Text>
          <Text color="cyan">Next steps:</Text>
          <Text dimColor> npx playwright test</Text>
          {dataset.cases.some((c) => c.expect?.snapshot) && (
            <>
              <Text> </Text>
              <Text color="cyan">Snapshot testing:</Text>
              <Text dimColor> First run will capture snapshots</Text>
              <Text dimColor>
                {' '}
                Update: npx playwright test --update-snapshots
              </Text>
            </>
          )}
        </Box>
      )}

      {/* Error */}
      {step === 'error' && error && (
        <Box flexDirection="column">
          <StatusMessage status="error">{error}</StatusMessage>
          <Text dimColor>Press Ctrl+C to exit</Text>
        </Box>
      )}
    </Box>
  );
}
