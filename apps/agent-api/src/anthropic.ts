import Anthropic from '@anthropic-ai/sdk';

/**
 * The key is read from the environment and never leaves this service. The
 * browser talks to us; we talk to Anthropic. Putting it in the frontend would
 * publish it — anything the browser can read, a visitor can read.
 */
export function model(): string {
  return process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set.');
    this.name = 'MissingApiKeyError';
  }
}

/** The model declined the request. Distinct from an error — the call worked. */
export class RefusedError extends Error {
  readonly category: string | null;

  constructor(category: string | null) {
    super('The model declined to answer this request.');
    this.name = 'RefusedError';
    this.category = category;
  }
}

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();
  // The SDK reads ANTHROPIC_API_KEY itself; passing it explicitly would only
  // add a place for it to be logged.
  cached ??= new Anthropic();
  return cached;
}

export type Reply = {
  model: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type ModelFailure = { code: string; message: string };

/**
 * Turns a thrown error into something an analyst can read. Returns null for
 * anything unrecognised so it propagates and shows up as a 500 rather than
 * being quietly relabelled as a model problem.
 */
export function describeFailure(error: unknown): ModelFailure | null {
  if (error instanceof MissingApiKeyError) {
    return { code: 'NotConfigured', message: 'The server has no Anthropic API key configured.' };
  }
  if (error instanceof RefusedError) {
    return { code: 'ModelRefused', message: error.message };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      code: 'UpstreamAuthFailed',
      message: "The server's Anthropic credentials were rejected.",
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { code: 'RateLimited', message: 'Anthropic is rate limiting us. Try again shortly.' };
  }
  if (error instanceof Anthropic.APIError) {
    // Pass the upstream message through. "Anthropic returned 400" sent me
    // debugging the request shape when the real answer — an empty credit
    // balance — was sitting in the body all along.
    return {
      code: 'UpstreamError',
      message: `Anthropic returned ${error.status}: ${upstreamMessage(error)}`,
    };
  }
  return null;
}

/** Digs the human-readable message out of an SDK error, whatever shape it took. */
function upstreamMessage(error: Error): string {
  const body = (error as { error?: { error?: { message?: string } } }).error;
  return body?.error?.message ?? error.message;
}

/**
 * One prompt, one answer, no documents and no tools. This exists to prove the
 * integration works end to end before anything depends on it.
 *
 * Thinking is off and effort is low deliberately: this is a connectivity check,
 * and paying for reasoning on "say hello" proves nothing extra. Extraction in
 * step 7 will want the opposite settings.
 */
export async function ask(prompt: string): Promise<Reply> {
  const response = await client().messages.create({
    model: model(),
    max_tokens: 256,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new RefusedError(response.stop_details?.category ?? null);
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return {
    model: response.model,
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
