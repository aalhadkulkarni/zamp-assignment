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

const EXTRACTION = {
  summary: 'Found the investments total.',
  fields: [
    {
      key: 'total_investments',
      valueAsPrinted: 462_090_073,
      unitsMultiplier: 1000,
      confidence: 'high',
      sourcePage: 1,
      sourceText: 'Total Investments $462,090,073',
      reasoning: 'PERF A column.',
    },
  ],
};

const reply = (overrides: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
  usage: { input_tokens: 24_180, output_tokens: 742 },
  ...overrides,
});

const pdf = () => ({
  filename: 'acfr.pdf',
  extension: '.pdf',
  bytes: Buffer.from('%PDF-1.4 pretend'),
});

const SCHEMA = { type: 'object' } as Record<string, unknown>;

let mod: typeof import('./anthropic.js');

beforeEach(async () => {
  vi.resetModules();
  create.mockReset();
  create.mockResolvedValue(reply());
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.FIXTURE_DELAY_MS = '0';
  mod = await import('./anthropic.js');
});

afterEach(() => {
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.FIXTURE_DELAY_MS;
});

describe('model', () => {
  it('defaults to opus 5 and can be overridden by the environment', () => {
    expect(mod.model()).toBe('claude-opus-5');
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    expect(mod.model()).toBe('claude-sonnet-5');
  });
});

describe('fixtureDelayMs', () => {
  it('pauses for a second unless told otherwise', () => {
    delete process.env.FIXTURE_DELAY_MS;
    expect(mod.fixtureDelayMs()).toBe(1000);

    process.env.FIXTURE_DELAY_MS = '0';
    expect(mod.fixtureDelayMs()).toBe(0);

    // A junk value falls back rather than becoming NaN, which setTimeout would
    // treat as zero and silently undo the whole point.
    process.env.FIXTURE_DELAY_MS = 'soon';
    expect(mod.fixtureDelayMs()).toBe(1000);
  });
});

describe('extract', () => {
  it('returns the parsed extraction, the model, and what it cost', async () => {
    const result = await mod.extract('find these', [pdf()], SCHEMA);

    expect(result).toEqual({
      model: 'claude-opus-5',
      extraction: EXTRACTION,
      usage: { inputTokens: 24_180, outputTokens: 742 },
      fixture: false,
    });
  });

  it('attaches a pdf as a document block and text as text', async () => {
    await mod.extract('find these', [
      pdf(),
      { filename: 'notes.md', extension: '.md', bytes: Buffer.from('in thousands') },
    ], SCHEMA);

    const [{ messages }] = create.mock.calls[0];
    const [first, second, instruction] = messages[0].content;

    expect(first).toMatchObject({ type: 'document', title: 'acfr.pdf' });
    expect(first.source.media_type).toBe('application/pdf');
    expect(second.text).toContain('in thousands');
    // Instruction last: the ask lands better after the material it applies to.
    expect(instruction.text).toBe('find these');
  });

  it('constrains the answer to the schema it was given', async () => {
    await mod.extract('find these', [pdf()], SCHEMA);

    const [params] = create.mock.calls[0];
    expect(params.output_config.format).toEqual({ type: 'json_schema', schema: SCHEMA });
  });

  it('thinks, because picking the right column is worth paying for', async () => {
    await mod.extract('find these', [pdf()], SCHEMA);

    const [params] = create.mock.calls[0];
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config.effort).toBe('high');
  });

  it('refuses to call out at all when no key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(mod.extract('find these', [pdf()], SCHEMA)).rejects.toBeInstanceOf(
      mod.MissingApiKeyError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * A refusal is a successful HTTP call with a declined answer, so it arrives as
   * a normal response rather than a thrown error. Parsing the content without
   * checking would blow up on an empty body and look like a malformed reply.
   */
  it('treats a refusal as a failure and keeps the category', async () => {
    create.mockResolvedValue(
      reply({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } }),
    );

    await expect(mod.extract('find these', [pdf()], SCHEMA)).rejects.toMatchObject({
      name: 'RefusedError',
      category: 'cyber',
    });
  });

  it('lets SDK errors through for the route to map', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const Stub = Anthropic.RateLimitError as unknown as new (status: number) => Error;
    create.mockRejectedValue(new Stub(429));

    await expect(mod.extract('find these', [pdf()], SCHEMA)).rejects.toBeInstanceOf(
      Anthropic.RateLimitError,
    );
  });
});

describe('extractFixture', () => {
  it('answers from the recording without touching the SDK', async () => {
    const result = await mod.extractFixture('ignored', [], SCHEMA);

    expect(result.fixture).toBe(true);
    expect(result.extraction.fields).toHaveLength(5);
    expect(create).not.toHaveBeenCalled();
  });

  /** A fixture where everything is found hides the blank-value rendering. */
  it('includes a value it could not find', async () => {
    const { extraction } = await mod.extractFixture('ignored', [], SCHEMA);

    const blank = extraction.fields.find((f) => f.key === 'total_receivables');
    expect(blank?.valueAsPrinted).toBeNull();
    expect(blank?.confidence).toBe('low');
  });

  /** Printed in thousands, as the document prints it, so units get exercised. */
  it('reports figures unscaled, with the multiplier alongside', async () => {
    const { extraction } = await mod.extractFixture('ignored', [], SCHEMA);

    const investments = extraction.fields.find((f) => f.key === 'total_investments');
    expect(investments?.valueAsPrinted).toBe(462_090_073);
    expect(investments?.unitsMultiplier).toBe(1000);
  });

  it('waits before answering, so loading states are visible', async () => {
    process.env.FIXTURE_DELAY_MS = '80';
    const fresh = await import('./anthropic.js');

    const started = Date.now();
    await fresh.extractFixture('ignored', [], SCHEMA);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});
