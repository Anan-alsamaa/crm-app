/**
 * AIProvider — the swappable interface every model integration implements.
 *
 * The gateway is provider-agnostic by design (spec FR-024). Endpoints call
 * `provider.run(...)` after redaction; the provider returns raw text which
 * the endpoint then parses into its typed response.
 *
 * Keeping this thin (single `run` method) means a new provider is one file
 * plus a config flag — no endpoint touches the provider directly.
 */

export interface AiRunInput {
  /** Stable identifier for the calling endpoint — used for cache keys + logging. */
  endpoint: string;
  /** The system / role prompt. Already redacted. */
  system: string;
  /** The user / context prompt. Already redacted. */
  user: string;
  /** Optional sampling temperature override. */
  temperature?: number;
  /** Optional max output tokens. */
  maxOutputTokens?: number;
}

export interface AiRunOutput {
  /** Raw model text. Already trimmed. */
  text: string;
  /** Provider model identifier (e.g. `gemini-1.5-flash`). */
  model: string;
}

export interface AIProvider {
  /** Human-readable provider name (`gemini`). */
  name: string;
  /** Run a single prompt round-trip. */
  run(input: AiRunInput): Promise<AiRunOutput>;
}

/** Thrown when the configured provider is unavailable (no key, network, quota). */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'upstream' | 'rate_limited' | 'invalid_response',
    readonly status: number = 502,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
