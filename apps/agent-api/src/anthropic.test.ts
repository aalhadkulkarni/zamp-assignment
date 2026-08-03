import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SDK is stubbed throughout. These tests are about our own handling of what
 * comes back — running them against the real API would be slow, flaky, and
 * would spend tokens on every `npm test`.
 */
const create = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number) {
      super(`api error ${status}`);
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}

  // A class, not an arrow function — the real SDK is constructed with `new`.
  class Anthropic {
    messages = { create };
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
  }

  return { default: Anthropic };
});

const reply = (overrides: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'pong' }],
  usage: { input_tokens: 12, output_tokens: 3 },
  ...overrides,
});

let ask: typeof import('./anthropic.js').ask;
let MissingApiKeyError: typeof import('./anthropic.js').MissingApiKeyError;
let RefusedError: typeof import('./anthropic.js').RefusedError;
let model: typeof import('./anthropic.js').model;

beforeEach(async () => {
  vi.resetModules();
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  ({ ask, MissingApiKeyError, RefusedError, model } = await import('./anthropic.js'));
});

afterEach(() => {
  delete process.env.ANTHROPIC_MODEL;
});

describe('model', () => {
  it('defaults to opus 5 and can be overridden by the environment', () => {
    expect(model()).toBe('claude-opus-5');
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    expect(model()).toBe('claude-sonnet-5');
  });
});

describe('ask', () => {
  it('returns the text, the model that answered, and what it cost', async () => {
    create.mockResolvedValue(reply());

    await expect(ask('ping')).resolves.toEqual({
      model: 'claude-opus-5',
      text: 'pong',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('joins multiple text blocks and ignores non-text ones', async () => {
    create.mockResolvedValue(
      reply({
        content: [
          { type: 'thinking', thinking: 'should not appear' },
          { type: 'text', text: 'one ' },
          { type: 'text', text: 'two' },
        ],
      }),
    );

    await expect(ask('ping')).resolves.toMatchObject({ text: 'one two' });
  });

  it('sends the prompt to the configured model', async () => {
    create.mockResolvedValue(reply());
    await ask('what is 2 + 2?');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'what is 2 + 2?' }],
      }),
    );
  });

  it('refuses to call out at all when no key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(ask('ping')).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * A refusal is a successful HTTP call with a declined answer, so it arrives
   * as a normal response rather than a thrown error. Reading content[0] without
   * checking would return an empty string and look like a working call.
   */
  it('treats a refusal as a failure and keeps the category', async () => {
    create.mockResolvedValue(
      reply({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } }),
    );

    await expect(ask('ping')).rejects.toMatchObject({
      name: 'RefusedError',
      category: 'cyber',
    });
    await expect(ask('ping')).rejects.toBeInstanceOf(RefusedError);
  });

  it('lets SDK errors through for the route to map', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    create.mockRejectedValue(new Anthropic.RateLimitError(429));

    await expect(ask('ping')).rejects.toBeInstanceOf(Anthropic.RateLimitError);
  });
});
