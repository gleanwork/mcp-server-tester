import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Select, TextInput, ConfirmInput } from '@inkjs/ui';
import type { Client, Tool } from '@modelcontextprotocol/client';
import { callToolNormalized } from '../../../mcp/callTool.js';
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
import { suggestExpectations } from '../../utils/expectationSuggester.js';
import {
  appendToolChecks,
  canAppendToolChecks,
  renderToolTestSpec,
  type ToolCheck,
} from '../../utils/toolTestSpec.js';
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
  | 'suiteName'
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
  // The whole result, which an exact-match assertion compares against.
  const [fullResult, setFullResult] = useState<unknown>(null);
  const [callError, setCallError] = useState<string | null>(null);

  // Schema form state
  const [schemaProperties, setSchemaProperties] = useState<SchemaProperty[]>(
    []
  );
  const [currentPropertyIndex, setCurrentPropertyIndex] = useState(0);
  const [argValues, setArgValues] = useState<Record<string, unknown>>({});

  // Spec state: the tests to write, and the file they go into
  const [spec, setSpec] = useState<{ name: string; checks: ToolCheck[] }>({
    name: 'MCP tools',
    checks: [],
  });
  const [existingSource, setExistingSource] = useState<string | null>(null);
  const [outputPath] = useState(
    resolve(options.output || 'tests/generated.spec.ts')
  );

  // Current test state
  const [currentCase, setCurrentCase] = useState<Partial<ToolCheck>>({});
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
          setStep('suiteName');
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
      const result = await callToolNormalized(client, {
        name: selectedTool.name,
        arguments: finalArgs,
      });
      const responseData = result.structuredContent ?? result.content;
      setResponse(responseData);
      setFullResult(result);
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

  /** Add the recorded call as a test. */
  function addCheck(check: Partial<ToolCheck>) {
    const complete: ToolCheck = {
      id: check.id!,
      toolName: check.toolName!,
      args: check.args!,
      ...(check.description !== undefined
        ? { description: check.description }
        : {}),
      ...(check.containsText ? { containsText: check.containsText } : {}),
      ...(check.matchesPattern ? { matchesPattern: check.matchesPattern } : {}),
      ...(check.response !== undefined ? { response: check.response } : {}),
      ...(check.snapshot ? { snapshot: true } : {}),
    };
    setSpec((current) => ({
      ...current,
      checks: [...current.checks, complete],
    }));
  }

  async function saveSpec() {
    try {
      const source =
        existingSource !== null
          ? appendToolChecks(existingSource, spec.checks)
          : renderToolTestSpec(spec.name, spec.checks);
      // Create directory if it doesn't exist
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, source);
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
                Run: <Text color="cyan">mst login {mcpConfig.serverUrl}</Text>
              </Text>
              <Text> </Text>
              <Text dimColor>Then retry: mst generate</Text>
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
          <Text>Spec file exists at {outputPath}. Add tests to it?</Text>
          <ConfirmInput
            onConfirm={async () => {
              const content = await readFile(outputPath, 'utf-8');
              if (!canAppendToolChecks(content)) {
                setError(
                  `${outputPath} wasn't written by mst generate, so it can't add tests to it. Choose a new --output file.`
                );
                setStep('error');
                return;
              }
              setExistingSource(content);
              setStep('selectTool');
            }}
            onCancel={() => setStep('suiteName')}
          />
        </Box>
      )}

      {/* Test suite name */}
      {step === 'suiteName' && (
        <Box flexDirection="column">
          {client && (
            <StatusMessage status="success">
              Connected! Found {tools.length} tools
            </StatusMessage>
          )}
          <Text> </Text>
          <Text>Test suite name:</Text>
          <TextInput
            defaultValue="MCP tools"
            onSubmit={(value) => {
              setSpec((current) => ({ ...current, name: value }));
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
          <Text>Test name:</Text>
          <TextInput
            defaultValue={`${selectedTool?.name}-${spec.checks.length + 1}`}
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
                // Skip to adding the test with a snapshot
                addCheck({
                  ...currentCase,
                  description: value || undefined,
                  snapshot: true,
                });
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
                containsText: suggestions.textContains,
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
                matchesPattern: suggestions.regex,
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
              setCurrentCase((c) => ({ ...c, response: fullResult }));
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
              addCheck({ ...currentCase, snapshot: true });
              setStep('askContinue');
            }}
            onCancel={() => {
              addCheck(currentCase);
              setStep('askContinue');
            }}
          />
        </Box>
      )}

      {/* Ask continue */}
      {step === 'askContinue' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Added test "{currentCase.id}"
          </StatusMessage>
          <Text>Total tests: {spec.checks.length}</Text>
          <Text> </Text>
          <Text>Add another test?</Text>
          <ConfirmInput
            onConfirm={() => {
              setCurrentCase({});
              setSelectedTool(null);
              setSchemaProperties([]);
              setCurrentPropertyIndex(0);
              setArgValues({});
              setResponse(null);
              setFullResult(null);
              setCallError(null);
              setSuggestions({ textContains: [], regex: [] });
              setStep('selectTool');
            }}
            onCancel={() => {
              setStep('saving');
              setTimeout(() => saveSpec(), 0);
            }}
          />
        </Box>
      )}

      {/* Saving */}
      {step === 'saving' && <Spinner label="Saving spec..." />}

      {/* Done */}
      {step === 'done' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Spec generation complete!
          </StatusMessage>
          <Text> </Text>
          <Text color="cyan">Tests added: {spec.checks.length}</Text>
          <Text dimColor>Output: {outputPath}</Text>
          <Text> </Text>
          <Text color="cyan">Next steps:</Text>
          <Text dimColor> npx playwright test {outputPath}</Text>
          {spec.checks.some((check) => check.snapshot) && (
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
