import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROMPT_LENGTH } from './config.js';

/**
 * Separate from app.test.ts so the SDK mock does not leak into the upload
 * tests, which exercise the real HTTP stack.
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

  class Anthropic {
    messages = { create };
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
  }

  return { default: Anthropic };
});

async function post(body: unknown) {
  const { buildApp } = await import('./app.js');
  const app = await buildApp();
  const response = await app.inject({ method: 'POST', url: '/llm/ping', payload: body });
  await app.close();
  return { status: response.statusCode, body: response.json() };
}

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  create.mockResolvedValue({
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'pong' }],
    usage: { input_tokens: 12, output_tokens: 3 },
  });
});

describe('POST /llm/ping', () => {
  it('returns the model reply', async () => {
    const { status, body } = await post({});

    expect(status).toBe(200);
    expect(body).toEqual({
      model: 'claude-opus-5',
      text: 'pong',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('uses the caller prompt when one is given', async () => {
    await post({ prompt: 'name three pension funds' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'name three pension funds' }],
      }),
    );
  });

  it('falls back to a default prompt when the body is empty or blank', async () => {
    await post({ prompt: '   ' });

    const [{ messages }] = create.mock.calls[0];
    expect(messages[0].content).toMatch(/pong/);
  });

  it('rejects an oversized prompt without calling out', async () => {
    const { status, body } = await post({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) });

    expect(status).toBe(400);
    expect(body.error).toBe('InvalidPrompt');
    expect(create).not.toHaveBeenCalled();
  });

  it('says plainly when the server has no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { status, body } = await post({});

    expect(status).toBe(503);
    expect(body.error).toBe('NotConfigured');
    expect(body.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('reports a refusal as its own outcome, not a generic failure', async () => {
    create.mockResolvedValue({
      model: 'claude-opus-5',
      stop_reason: 'refusal',
      content: [],
      stop_details: { category: 'cyber' },
      usage: { input_tokens: 5, output_tokens: 0 },
    });

    const { status, body } = await post({ prompt: 'something declined' });
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'ModelRefused', category: 'cyber' });
  });

  /** Our credential is broken, not the caller's — so 502, never 401. */
  it('maps a rejected API key to a gateway error', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    create.mockRejectedValue(new Anthropic.AuthenticationError(401));

    const { status, body } = await post({});
    expect(status).toBe(502);
    expect(body.error).toBe('UpstreamAuthFailed');
  });

  it('passes a rate limit through as a rate limit', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    create.mockRejectedValue(new Anthropic.RateLimitError(429));

    const { status, body } = await post({});
    expect(status).toBe(429);
    expect(body.error).toBe('RateLimited');
  });

  it('maps other upstream failures to 502', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    create.mockRejectedValue(new Anthropic.APIError(529));

    const { status, body } = await post({});
    expect(status).toBe(502);
    expect(body.error).toBe('UpstreamError');
  });
});
