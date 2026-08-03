import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import type { Extraction } from './extraction.js';

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
  /** True when this came from a recording rather than the API. */
  fixture: boolean;
};

/**
 * Fixture mode returns a recorded reply instead of calling the API, so that
 * development and the test suite cost nothing. Off unless asked for — a
 * deployed service must never serve a recording by accident, and the failure
 * mode is silent because a fixture looks like a real answer.
 */
export function usingFixtures(): boolean {
  return process.env.USE_FIXTURES === 'true';
}

/**
 * A recorded reply returns instantly, which is the one way fixture mode lies
 * about the real thing. Loading states never appear, so they never get built or
 * noticed until a real call puts them on screen for several seconds.
 *
 * Overridable so the test suite does not pay the delay on every run.
 */
export function fixtureDelayMs(): number {
  const configured = Number(process.env.FIXTURE_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1000;
}

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
    fixture: false,
  };
}

/** A document on its way to the model. PDFs go as documents, text as text. */
export type Attachment = {
  filename: string;
  /** '.pdf' | '.txt' | '.md' */
  extension: string;
  bytes: Buffer;
};

export type ExtractionReply = {
  model: string;
  extraction: Extraction;
  usage: { inputTokens: number; outputTokens: number };
  fixture: boolean;
};

/**
 * Extraction, with the documents attached and the answer constrained to the
 * customer's field list.
 *
 * Adaptive thinking here, unlike the acknowledgement call: reading the right
 * figure out of a table with six columns and a units heading three inches away
 * is exactly the kind of work worth paying to think about.
 */
export async function extract(
  prompt: string,
  attachments: Attachment[],
  schema: Record<string, unknown>,
): Promise<ExtractionReply> {
  const content = [
    ...attachments.map((file) =>
      file.extension === '.pdf'
        ? ({
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: 'application/pdf' as const,
              data: file.bytes.toString('base64'),
            },
            title: file.filename,
          })
        : ({
            type: 'text' as const,
            text: `--- ${file.filename} ---\n${file.bytes.toString('utf8')}`,
          }),
    ),
    // Documents first, instruction last: the model reads in order, and the ask
    // lands better after the material it applies to.
    { type: 'text' as const, text: prompt },
  ];

  const response = await client().messages.create({
    model: model(),
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new RefusedError(response.stop_details?.category ?? null);
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    model: response.model,
    // Structured outputs guarantee the shape, so a parse failure here means
    // something upstream changed rather than the model wandering off.
    extraction: JSON.parse(text) as Extraction,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    fixture: false,
  };
}

/**
 * Same signature as `ask`, no network call. The text below is a real reply
 * recorded from claude-opus-5 on 2026-08-03, not something invented — a made-up
 * fixture drifts from what the model actually says, and then the UI is tuned
 * against prose the model never produces.
 *
 * The prompt is accepted and ignored. Keeping the signature identical is what
 * lets the route pick between the two without knowing which it has.
 */
/**
 * A recorded extraction, shaped exactly like a real one. The figures are the
 * real CalPERS PERF A column, printed in thousands as the document prints them,
 * so the units arithmetic downstream is exercised rather than bypassed.
 *
 * total_receivables is deliberately left null. A fixture where everything
 * succeeds hides the null rendering, the confidence rendering, and the
 * "what do I do about a blank" question — which is most of what the review table
 * exists to handle.
 */
export async function extractFixture(
  _prompt: string,
  _attachments: Attachment[],
  _schema: Record<string, unknown>,
): Promise<ExtractionReply> {
  await sleep(fixtureDelayMs());

  return {
    model: 'claude-opus-5',
    fixture: true,
    usage: { inputTokens: 24_180, outputTokens: 742 },
    extraction: {
      summary:
        'I found four of the five values on the statement of fiduciary net position. ' +
        'The figures are reported in thousands, and this page carries six plan columns — ' +
        'I read PERF A, the largest. Total receivables is shown only as a breakdown by ' +
        'counterparty, with no combined line, so I have left it blank rather than adding ' +
        'the components up myself.',
      fields: [
        {
          key: 'total_receivables',
          valueAsPrinted: null,
          unitsMultiplier: 1000,
          confidence: 'low',
          sourcePage: 1,
          sourceText: '',
          reasoning:
            'No combined receivables line in the PERF A column; only the individual counterparty rows.',
        },
        {
          key: 'total_investments',
          valueAsPrinted: 462_090_073,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: 'Total Investments $462,090,073',
          reasoning: 'Investments at Fair Value section, PERF A column.',
        },
        {
          key: 'total_assets',
          valueAsPrinted: 508_215_927,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: 'TOTAL ASSETS $508,215,927',
          reasoning: 'PERF A column, before deferred outflows of resources.',
        },
        {
          key: 'total_liabilities',
          valueAsPrinted: 98_831_325,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: 'TOTAL LIABILITIES $98,831,325',
          reasoning: 'PERF A column, before deferred inflows of resources.',
        },
        {
          key: 'net_position',
          valueAsPrinted: 409_424_367,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText:
            'NET POSITION – RESTRICTED FOR PENSION, OTHER POST-EMPLOYMENT, REPLACEMENT BENEFITS AND PROGRAM ADMINISTRATION $409,424,367',
          reasoning: 'PERF A column. Labelled at length here, but it is the net position line.',
        },
      ],
    },
  };
}

export async function askFixture(_prompt: string): Promise<Reply> {
  await sleep(fixtureDelayMs());

  return {
    model: 'claude-opus-5',
    text:
      "Received your documents. I haven't opened or read them yet — extraction " +
      "is the next step, and I'll follow up once that's in place.",
    usage: { inputTokens: 236, outputTokens: 70 },
    fixture: true,
  };
}
