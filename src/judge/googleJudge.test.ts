import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Google AI SDK before importing the judge (Vitest hoists vi.mock)
const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn().mockReturnValue({
  generateContent: mockGenerateContent,
});
const MockGoogleGenerativeAI = vi.fn().mockImplementation(() => ({
  getGenerativeModel: mockGetGenerativeModel,
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

import { createGoogleJudge } from './googleJudge.js';

function makeGenerateResponse(
  text: string,
  options: {
    promptTokens?: number;
    candidatesTokens?: number;
  } = {}
) {
  return {
    response: {
      text: () => text,
      usageMetadata: {
        promptTokenCount: options.promptTokens ?? 100,
        candidatesTokenCount: options.candidatesTokens ?? 50,
      },
    },
  };
}

describe('googleJudge', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, GOOGLE_API_KEY: 'test-google-key' };
    // Reset the mock implementation after clearAllMocks
    mockGetGenerativeModel.mockReturnValue({
      generateContent: mockGenerateContent,
    });
    MockGoogleGenerativeAI.mockImplementation(() => ({
      getGenerativeModel: mockGetGenerativeModel,
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createGoogleJudge', () => {
    it('throws when API key is not set', () => {
      delete process.env.GOOGLE_API_KEY;

      expect(() => createGoogleJudge({})).toThrow(
        'Google judge requires an API key'
      );
    });

    it('throws when custom apiKeyEnvVar is not set', () => {
      delete process.env.MY_GOOGLE_KEY;

      expect(() =>
        createGoogleJudge({ apiKeyEnvVar: 'MY_GOOGLE_KEY' })
      ).toThrow(
        'Google judge requires an API key. Set the MY_GOOGLE_KEY environment variable.'
      );
    });

    it('creates a judge with evaluate method', () => {
      const judge = createGoogleJudge({});

      expect(judge).toBeDefined();
      expect(typeof judge.evaluate).toBe('function');
    });
  });

  describe('evaluate', () => {
    it('returns pass=true when response has pass:true', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 0.9, reasoning: 'Well done' })
        )
      );

      const judge = createGoogleJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.9);
      expect(result.reasoning).toBe('Well done');
    });

    it('returns pass=false when response has pass:false', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: false, score: 0.2, reasoning: 'Too vague' })
        )
      );

      const judge = createGoogleJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.2);
      expect(result.reasoning).toBe('Too vague');
    });

    it('throws when response is missing required pass field', async () => {
      // When pass field is missing, schema validation rejects it
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({
            score: 0.85,
            reasoning: 'Good score but no pass field',
          })
        )
      );

      const judge = createGoogleJudge({});

      await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
        'Judge returned invalid response'
      );
    });

    it('throws on invalid JSON response', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse('This is not valid JSON at all')
      );

      const judge = createGoogleJudge({});

      await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
        'Failed to parse judge response as JSON'
      );
    });

    it('propagates API errors (does not swallow them)', async () => {
      mockGenerateContent.mockRejectedValue(
        new Error('Google API quota exceeded')
      );

      const judge = createGoogleJudge({});

      await expect(judge.evaluate('candidate', null, 'rubric')).rejects.toThrow(
        'Google API quota exceeded'
      );
    });

    it('strips markdown code blocks from response before parsing', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          '```json\n{"pass": true, "score": 0.88, "reasoning": "Matches reference"}\n```'
        )
      );

      const judge = createGoogleJudge({});
      const result = await judge.evaluate('candidate', 'reference', 'rubric');

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.88);
      expect(result.reasoning).toBe('Matches reference');
    });

    it('includes token usage in result', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 0.8, reasoning: 'OK' }),
          { promptTokens: 250, candidatesTokens: 80 }
        )
      );

      const judge = createGoogleJudge({});
      const result = await judge.evaluate('candidate', null, 'rubric');

      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBe(250);
      expect(result.usage?.outputTokens).toBe(80);
    });

    it('uses the default model gemini-2.0-flash when not specified', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 1.0, reasoning: 'Perfect' })
        )
      );

      const judge = createGoogleJudge({});
      await judge.evaluate('candidate', null, 'rubric');

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.0-flash' })
      );
    });

    it('uses the specified model override', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 1.0, reasoning: 'Perfect' })
        )
      );

      const judge = createGoogleJudge({ model: 'gemini-1.5-pro' });
      await judge.evaluate('candidate', null, 'rubric');

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-1.5-pro' })
      );
    });

    it('handles null reference by not including it in the prompt', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 0.9, reasoning: 'Good' })
        )
      );

      const judge = createGoogleJudge({});
      await judge.evaluate('candidate', null, 'rubric');

      // Should have been called with content that does NOT include "Reference answer"
      const callArg = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(callArg).not.toContain('Reference answer');
    });

    it('includes reference in prompt when provided', async () => {
      mockGenerateContent.mockResolvedValue(
        makeGenerateResponse(
          JSON.stringify({ pass: true, score: 0.9, reasoning: 'Good' })
        )
      );

      const judge = createGoogleJudge({});
      await judge.evaluate('candidate', 'expected reference output', 'rubric');

      const callArg = mockGenerateContent.mock.calls[0]?.[0] as string;
      expect(callArg).toContain('expected reference output');
    });
  });
});
