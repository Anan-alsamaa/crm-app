import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIProvider, AiRunInput, AiRunOutput } from './types.js';
import { AiProviderError } from './types.js';

/**
 * Gemini provider — wraps @google/generative-ai. The `system` prompt becomes
 * a systemInstruction; the `user` prompt is the single content message.
 *
 * Throws AiProviderError on configuration/quota/upstream issues so the route
 * layer can translate to a clean HTTP status without leaking internals.
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenerativeAI;
  private readonly model: string;

  constructor(apiKey: string, model = 'gemini-1.5-flash') {
    if (!apiKey) {
      throw new AiProviderError('GEMINI_API_KEY is not configured', 'not_configured', 503);
    }
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async run(input: AiRunInput): Promise<AiRunOutput> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: input.system,
      generationConfig: {
        temperature: input.temperature ?? 0.4,
        maxOutputTokens: input.maxOutputTokens ?? 1024,
      },
    });
    try {
      const result = await model.generateContent(input.user);
      const text = result.response.text().trim();
      return { text, model: this.model };
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      // Map common Google API failures to our typed error.
      if (/quota|rate/i.test(msg)) {
        throw new AiProviderError(msg, 'rate_limited', 429);
      }
      if (/api key|unauthorized|permission/i.test(msg)) {
        throw new AiProviderError(msg, 'not_configured', 503);
      }
      throw new AiProviderError(msg, 'upstream', 502);
    }
  }
}
