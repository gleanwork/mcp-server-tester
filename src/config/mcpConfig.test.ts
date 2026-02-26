import { describe, it, expect, vi } from 'vitest';
import {
  type MCPConfig,
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
} from './mcpConfig.js';
import { ZodError } from 'zod';

describe('MCPConfig', () => {
  describe('validateMCPConfig', () => {
    describe('stdio config', () => {
      it('should validate valid stdio config', () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          args: ['server.js'],
        };

        const result = validateMCPConfig(config);

        expect(result).toEqual(config);
      });

      it('should validate stdio config without args', () => {
        const config = {
          transport: 'stdio' as const,
          command: 'npx',
        };

        const result = validateMCPConfig(config);

        expect(result.transport).toBe('stdio');
        expect(result.command).toBe('npx');
      });

      it('should validate stdio config with capabilities', () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          capabilities: {
            roots: { listChanged: true },
          },
        };

        const result = validateMCPConfig(config);

        expect(result.capabilities).toEqual({
          roots: { listChanged: true },
        });
      });

      it('should reject stdio config without command', () => {
        const config = {
          transport: 'stdio',
        };

        expect(() => validateMCPConfig(config)).toThrow(ZodError);
      });

      it('should reject stdio config with empty command', () => {
        const config = {
          transport: 'stdio',
          command: '',
        };

        expect(() => validateMCPConfig(config)).toThrow(ZodError);
      });
    });

    describe('http config', () => {
      it('should validate valid http config', () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'http://localhost:3000/mcp',
        };

        const result = validateMCPConfig(config);

        expect(result).toEqual(config);
      });

      it('should validate http config with capabilities', () => {
        const config = {
          transport: 'http' as const,
          serverUrl: 'https://api.example.com/mcp',
          capabilities: {
            sampling: { temperature: 0.7 },
          },
        };

        const result = validateMCPConfig(config);

        expect(result.capabilities).toEqual({
          sampling: { temperature: 0.7 },
        });
      });

      it('should reject http config without serverUrl', () => {
        const config = {
          transport: 'http',
        };

        expect(() => validateMCPConfig(config)).toThrow(ZodError);
      });

      it('should reject http config with invalid URL', () => {
        const config = {
          transport: 'http',
          serverUrl: 'not-a-url',
        };

        expect(() => validateMCPConfig(config)).toThrow(ZodError);
      });

      it('warns when http:// is used for a non-localhost serverUrl', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        validateMCPConfig({
          transport: 'http',
          serverUrl: 'http://remote.example.com/mcp',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('http://')
        );
        warnSpy.mockRestore();
      });

      it('does not warn when http:// is used for localhost', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        validateMCPConfig({
          transport: 'http',
          serverUrl: 'http://localhost:3000/mcp',
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('does not warn when http:// is used for 127.0.0.1', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        validateMCPConfig({
          transport: 'http',
          serverUrl: 'http://127.0.0.1:8080/mcp',
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('does not warn when https:// is used for a remote server', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        validateMCPConfig({
          transport: 'http',
          serverUrl: 'https://remote.example.com/mcp',
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('warning message includes the non-localhost hostname', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        validateMCPConfig({
          transport: 'http',
          serverUrl: 'http://my-server.internal/mcp',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('my-server.internal')
        );
        warnSpy.mockRestore();
      });
    });

    describe('common options', () => {
      it('should validate config with timeout options', () => {
        const config = {
          transport: 'stdio' as const,
          command: 'node',
          connectTimeoutMs: 5000,
          requestTimeoutMs: 10000,
        };

        const result = validateMCPConfig(config);

        expect(result.connectTimeoutMs).toBe(5000);
        expect(result.requestTimeoutMs).toBe(10000);
      });

      it('should reject negative timeout', () => {
        const config = {
          transport: 'stdio',
          command: 'node',
          connectTimeoutMs: -1,
        };

        expect(() => validateMCPConfig(config)).toThrow(ZodError);
      });
    });
  });

  describe('isStdioConfig', () => {
    it('should return true for stdio config', () => {
      const config: MCPConfig = {
        transport: 'stdio',
        command: 'node',
      };

      expect(isStdioConfig(config)).toBe(true);
    });

    it('should return false for http config', () => {
      const config: MCPConfig = {
        transport: 'http',
        serverUrl: 'http://localhost:3000',
      };

      expect(isStdioConfig(config)).toBe(false);
    });

    it('should narrow type correctly', () => {
      const config: MCPConfig = {
        transport: 'stdio',
        command: 'node',
      };

      if (isStdioConfig(config)) {
        // TypeScript should know config.command exists
        expect(config.command).toBe('node');
      }
    });
  });

  describe('isHttpConfig', () => {
    it('should return true for http config', () => {
      const config: MCPConfig = {
        transport: 'http',
        serverUrl: 'http://localhost:3000',
      };

      expect(isHttpConfig(config)).toBe(true);
    });

    it('should return false for stdio config', () => {
      const config: MCPConfig = {
        transport: 'stdio',
        command: 'node',
      };

      expect(isHttpConfig(config)).toBe(false);
    });

    it('should narrow type correctly', () => {
      const config: MCPConfig = {
        transport: 'http',
        serverUrl: 'http://localhost:3000',
      };

      if (isHttpConfig(config)) {
        // TypeScript should know config.serverUrl exists
        expect(config.serverUrl).toBe('http://localhost:3000');
      }
    });
  });
});
