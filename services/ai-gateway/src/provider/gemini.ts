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
    // Gemini's free/shared tiers return transient 503 "model overloaded"
    // spikes. Retry a couple of times with backoff before surfacing so a
    // single spike doesn't fail the agent's request.
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await model.generateContent(input.user);
        const text = result.response.text().trim();
        return { text, model: this.model };
      } catch (err) {
        lastErr = err;
        const status = parseHttpStatus((err as Error).message ?? '');
        if ((status === 503 || status === 429) && attempt < maxAttempts) {
          await delay(attempt * 500);
          continue;
        }
        throw classifyGeminiError(err);
      }
    }
    throw classifyGeminiError(lastErr);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull the HTTP status out of Google's `[503 Service Unavailable] ...` messages. */
function parseHttpStatus(message: string): number | null {
  const m = message.match(/\[(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Map a Google API failure to our typed error.
 *
 * Classify by the embedded HTTP status first — matching on words is unsafe
 * because the error message contains the request URL (`...:generateContent`),
 * and `generate` literally contains the substring "rate". A loose `/rate/`
 * test therefore mislabels *every* failure as `rate_limited`.
 */
function classifyGeminiError(err: unknown): AiProviderError {
  const msg = (err as Error)?.message ?? 'unknown';
  const status = parseHttpStatus(msg);

  if (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|exceeded your.*quota|too many requests/i.test(msg)
  ) {
    return new AiProviderError(msg, 'rate_limited', 429);
  }
  if (status === 401 || status === 403 || /api key|unauthorized|permission denied/i.test(msg)) {
    return new AiProviderError(msg, 'not_configured', 503);
  }
  if (status === 503 || status === 500 || status === 504 || /overloaded|unavailable/i.test(msg)) {
    return new AiProviderError(msg, 'provider_unavailable', 503);
  }
  return new AiProviderError(msg, 'upstream', 502);
}
