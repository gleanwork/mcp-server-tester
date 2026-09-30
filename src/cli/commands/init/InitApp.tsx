import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Select, TextInput, ConfirmInput } from '@inkjs/ui';
import { mkdir, writeFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { Spinner, StatusMessage } from '../../components/index.js';
import {
  getPlaywrightConfigTemplate,
  getTestFileTemplate,
  getDatasetTemplate,
  getGitignoreTemplate,
  getPackageJsonTemplate,
  getTsconfigTemplate,
} from '../../templates/index.js';

type Step =
  | 'projectName'
  | 'transportType'
  | 'serverCommand'
  | 'serverUrl'
  | 'installDeps'
  | 'confirmOverwrite'
  | 'creating'
  | 'installing'
  | 'done'
  | 'error';

export interface InitOptions {
  name?: string;
  dir?: string;
}

interface InitAppProps {
  options: InitOptions;
}

export function InitApp({ options }: InitAppProps) {
  const { exit } = useApp();

  // State machine
  const [step, setStep] = useState<Step>('projectName');

  // Form state
  const [projectName, setProjectName] = useState(
    options.name || 'my-mcp-tests'
  );
  const [transportType, setTransportType] = useState<'stdio' | 'http'>('stdio');
  const [serverCommand, setServerCommand] = useState('node server.js');
  const [serverUrl, setServerUrl] = useState('http://localhost:3000/mcp');
  const [installDeps, setInstallDeps] = useState(true);

  // Derived state
  const [targetDir] = useState(resolve(options.dir || '.'));
  const [projectPath, setProjectPath] = useState('');

  // Status state
  const [error, setError] = useState<string | null>(null);

  // Update project path when name changes
  useEffect(() => {
    setProjectPath(join(targetDir, projectName));
  }, [targetDir, projectName]);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
  });

  // Exit after rendering done/error
  useEffect(() => {
    if (step === 'done' || step === 'error') {
      exit();
    }
  }, [step, exit]);

  const createProject = useCallback(async () => {
    setStep('creating');

    try {
      // Create directories
      await mkdir(projectPath, { recursive: true });
      await mkdir(join(projectPath, 'tests'), { recursive: true });
      await mkdir(join(projectPath, 'data'), { recursive: true });

      // Build answers object for templates
      const answers = {
        projectName,
        transport: transportType,
        serverCommand: transportType === 'stdio' ? serverCommand : undefined,
        serverUrl: transportType === 'http' ? serverUrl : undefined,
        installDeps,
      };

      // Generate files
      const files = [
        {
          path: 'playwright.config.ts',
          content: getPlaywrightConfigTemplate(answers),
        },
        {
          path: 'tests/mcp.spec.ts',
          content: getTestFileTemplate(answers),
        },
        {
          path: 'data/example-dataset.json',
          content: getDatasetTemplate(answers),
        },
        {
          path: '.gitignore',
          content: getGitignoreTemplate(),
        },
        {
          path: 'package.json',
          content: getPackageJsonTemplate(projectName),
        },
        {
          path: 'tsconfig.json',
          content: getTsconfigTemplate(),
        },
      ];

      for (const file of files) {
        await writeFile(join(projectPath, file.path), file.content);
      }

      if (installDeps) {
        setStep('installing');
        await installDependencies();
      } else {
        setStep('done');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }, [
    projectPath,
    projectName,
    transportType,
    serverCommand,
    serverUrl,
    installDeps,
  ]);

  const installDependencies = useCallback(async () => {
    return new Promise<void>((resolvePromise, reject) => {
      const npm = spawn('npm', ['install'], {
        cwd: projectPath,
        stdio: 'pipe',
      });

      let stderrOutput = '';
      npm.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      npm.on('close', (code) => {
        if (code === 0) {
          setStep('done');
          resolvePromise();
        } else {
          // Include stderr in error message for debugging
          const errorMsg = stderrOutput.trim()
            ? `npm install failed: ${stderrOutput.trim().split('\n')[0]}`
            : `npm install exited with code ${code}`;
          setError(errorMsg);
          setStep('error');
          reject(new Error(errorMsg));
        }
      });

      npm.on('error', (err) => {
        setError(err.message);
        setStep('error');
        reject(err);
      });
    });
  }, [projectPath]);

  const checkAndCreate = useCallback(async () => {
    let dirExists = false;
    try {
      await stat(projectPath);
      dirExists = true;
    } catch {
      // Directory doesn't exist
    }

    if (dirExists) {
      setStep('confirmOverwrite');
    } else {
      await createProject();
    }
  }, [projectPath, createProject]);

  // Render based on step
  return (
    <Box flexDirection="column" padding={1}>
      {/* Project name */}
      {step === 'projectName' && (
        <Box flexDirection="column">
          <Text>Project name:</Text>
          <TextInput
            defaultValue={projectName}
            onSubmit={(value) => {
              if (value.length === 0) return;
              setProjectName(value);
              setStep('transportType');
            }}
          />
        </Box>
      )}

      {/* Transport type */}
      {step === 'transportType' && (
        <Box flexDirection="column">
          <Text>MCP transport type:</Text>
          <Select
            options={[
              { label: 'stdio (local server process)', value: 'stdio' },
              { label: 'http (remote server)', value: 'http' },
            ]}
            onChange={(value) => {
              setTransportType(value as 'stdio' | 'http');
              setStep(value === 'stdio' ? 'serverCommand' : 'serverUrl');
            }}
          />
        </Box>
      )}

      {/* Server command for stdio */}
      {step === 'serverCommand' && (
        <Box flexDirection="column">
          <Text>Server command (for stdio):</Text>
          <TextInput
            defaultValue={serverCommand}
            onSubmit={(value) => {
              setServerCommand(value);
              setStep('installDeps');
            }}
          />
        </Box>
      )}

      {/* Server URL for http */}
      {step === 'serverUrl' && (
        <Box flexDirection="column">
          <Text>Server URL (for http):</Text>
          <TextInput
            defaultValue={serverUrl}
            onSubmit={(value) => {
              setServerUrl(value);
              setStep('installDeps');
            }}
          />
        </Box>
      )}

      {/* Install dependencies */}
      {step === 'installDeps' && (
        <Box flexDirection="column">
          <Text>Install dependencies now?</Text>
          <ConfirmInput
            onConfirm={() => {
              setInstallDeps(true);
              checkAndCreate();
            }}
            onCancel={() => {
              setInstallDeps(false);
              checkAndCreate();
            }}
          />
        </Box>
      )}

      {/* Confirm overwrite */}
      {step === 'confirmOverwrite' && (
        <Box flexDirection="column">
          <Text color="yellow">
            Directory {projectName} already exists. Overwrite?
          </Text>
          <ConfirmInput
            onConfirm={() => createProject()}
            onCancel={() => {
              exit();
            }}
          />
        </Box>
      )}

      {/* Creating */}
      {step === 'creating' && <Spinner label="Creating project structure..." />}

      {/* Installing */}
      {step === 'installing' && <Spinner label="Installing dependencies..." />}

      {/* Done */}
      {step === 'done' && (
        <Box flexDirection="column">
          <StatusMessage status="success">
            Project initialized successfully!
          </StatusMessage>
          <Text> </Text>
          <Text color="cyan">Next steps:</Text>
          <Text dimColor> cd {projectName}</Text>
          {!installDeps && <Text dimColor> npm install</Text>}
          <Text dimColor> npm test</Text>
          <Text> </Text>
          <Text color="cyan">To generate a dataset:</Text>
          <Text dimColor> npx mst generate</Text>
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
