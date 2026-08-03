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
