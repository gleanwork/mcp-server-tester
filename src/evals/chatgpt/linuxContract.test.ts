import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import {
  LINUX_CHATGPT_ERROR_CODES,
  LINUX_CHATGPT_HELPER_ENVIRONMENT,
  LINUX_CHATGPT_RUNTIME_ENVIRONMENT,
  pickEnvironment,
} from './linuxContract.js';

describe('Linux ChatGPT shared contract', () => {
  it('ships the Node driver', () => {
    expect(packageJson.exports['./chatgpt-linux-runtime']).toBe(
      './dist/chatgpt/linuxDriver.js'
    );
  });

  it('has unique error codes and environment keys', () => {
    expect(new Set(LINUX_CHATGPT_ERROR_CODES).size).toBe(
      LINUX_CHATGPT_ERROR_CODES.length
    );
    expect(new Set(LINUX_CHATGPT_RUNTIME_ENVIRONMENT).size).toBe(
      LINUX_CHATGPT_RUNTIME_ENVIRONMENT.length
    );
  });

  it('never forwards model or MCP credentials or removed helper paths', () => {
    for (const key of [
      ...LINUX_CHATGPT_RUNTIME_ENVIRONMENT,
      ...LINUX_CHATGPT_HELPER_ENVIRONMENT,
    ])
      expect(key).not.toMatch(
        /(^|_)(API_KEY|TOKEN|SECRET|PASSWORD)(_|$)|^MST_/
      );
  });

  it('picks only defined allowlisted values', () => {
    expect(
      pickEnvironment(
        { HOME: '/fixture', DISPLAY: undefined, OPENAI_API_KEY: 'private' },
        LINUX_CHATGPT_RUNTIME_ENVIRONMENT
      )
    ).toEqual({ HOME: '/fixture' });
  });
});
