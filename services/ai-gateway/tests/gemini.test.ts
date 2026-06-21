import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Google SDK so we can drive run() outcomes without a network call.
const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({ getGenerativeModel })),
}));

import { GeminiProvider } from '../src/provider/gemini.js';
import { AiProviderError } from '../src/provider/types.js';

const input = {
  endpoint: 'summarize',
  system: 'You are helpful',
  user: 'Summarise this thread',
};

beforeEach(() => {
  generateContent.mockReset();
  getGenerativeModel.mockClear();
});

describe('GeminiProvider', () => {
  it('throws not_configured (503) when constructed without an API key', () => {
    expect(() => new GeminiProvider('')).toThrowError(AiProviderError);
    try {
      new GeminiProvider('');
    } catch (err) {
      expect((err as AiProviderError).code).toBe('not_configured');
      expect((err as AiProviderError).status).toBe(503);
    }
  });

  it('returns trimmed text and the model id on success', async () => {
    generateContent.mockResolvedValueOnce({ response: { text: () => '  hello  ' } });
    const provider = new GeminiProvider('key', 'gemini-1.5-pro');
    const out = await provider.run(input);
    expect(out).toEqual({ text: 'hello', model: 'gemini-1.5-pro' });
    expect(getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-1.5-pro', systemInstruction: 'You are helpful' }),
    );
  });

  it('maps quota/rate errors to rate_limited (429)', async () => {
    // Gemini signals quota with RESOURCE_EXHAUSTED; classification keys off that
    // (and HTTP status) rather than loose word-matching. No bracketed [429] here,
    // so it classifies directly without entering the 429/503 retry path.
    generateContent.mockRejectedValueOnce(
      new Error('RESOURCE_EXHAUSTED: Quota exceeded for this project'),
    );
    const provider = new GeminiProvider('key');
    await expect(provider.run(input)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('maps auth errors to not_configured (503)', async () => {
    generateContent.mockRejectedValueOnce(new Error('API key not valid'));
    const provider = new GeminiProvider('key');
    await expect(provider.run(input)).rejects.toMatchObject({
      code: 'not_configured',
      status: 503,
    });
  });

  it('maps everything else to upstream (502)', async () => {
    generateContent.mockRejectedValueOnce(new Error('socket hang up'));
    const provider = new GeminiProvider('key');
    await expect(provider.run(input)).rejects.toMatchObject({ code: 'upstream', status: 502 });
  });
});
