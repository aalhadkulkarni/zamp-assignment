import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis } from './diagnosis.js';
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
 * Adaptive thinking, and effort high. Reading the right figure out of a table
 * with six plan columns and a units heading three inches away is exactly the
 * kind of work worth paying to think about — a wrong number here is far more
 * expensive than the tokens.
 */
/** PDFs go as document blocks, text files inline. Shared so that extraction and
 *  diagnosis cannot drift apart in how they present the same pages. */
function documentBlocks(attachments: Attachment[]) {
  return attachments.map((file) =>
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
  );
}

export async function extract(
  prompt: string,
  attachments: Attachment[],
  schema: Record<string, unknown>,
): Promise<ExtractionReply> {
  const content = [
    ...documentBlocks(attachments),
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
 * A recorded extraction, shaped exactly like a real one. The figures are the
 * real CalPERS PERF A column, printed in thousands as the document prints them,
 * so the units arithmetic downstream is exercised rather than bypassed.
 *
 * total_receivables is deliberately left null. A fixture where everything
 * succeeds hides the null rendering, the confidence rendering, and the
 * "what do I do about a blank" question — which is most of what the review table
 * exists to handle.
 *
 * Arguments are accepted and ignored. An identical signature to `extract` is
 * what lets the route pick between the two without knowing which it got.
 */
/**
 * A recorded extraction, so the whole flow runs with no key and no spend.
 *
 * It reads its own inputs rather than ignoring them. When a ratified lesson has
 * reached the request — a label in the field's schema description, a rule in the
 * prompt — the recorded answer changes accordingly. That keeps the demo honest:
 * the second document improves because the lesson actually arrived, not because
 * a fixture was told to pretend it did. The assertion in the test is the same
 * one an analyst makes watching it.
 */
export async function extractFixture(
  prompt: string,
  _attachments: Attachment[],
  schema: Record<string, unknown>,
): Promise<ExtractionReply> {
  await sleep(fixtureDelayMs());

  const taught = describedFields(schema);

  // A wrong_source lesson lands in the prompt's reading instructions.
  const readsTotalColumn = /total column|combined column|all plans/i.test(prompt);
  // A synonym lesson lands in the field's own slot in the output schema.
  const knowsReceivablesLabel = /also been printed as/i.test(taught.total_receivables ?? '');

  const column = readsTotalColumn ? 'Total column' : 'PERF A column';

  const summary = readsTotalColumn
    ? 'I found the values on the statement of fiduciary net position. The figures are ' +
      'reported in thousands, and this page carries six plan columns — I read the Total ' +
      'column, as you confirmed. '
    : 'I found the values on the statement of fiduciary net position. The figures are ' +
      'reported in thousands, and this page carries six plan columns — I read PERF A, ' +
      'the largest. ';

  return {
    model: 'claude-opus-5',
    fixture: true,
    usage: { inputTokens: 24_180, outputTokens: 742 },
    extraction: {
      summary:
        summary +
        (knowsReceivablesLabel
          ? 'Receivables are printed under the label you confirmed, so I have read that line.'
          : 'Total receivables is shown only as a breakdown by counterparty, with no ' +
            'combined line, so I have left it blank rather than adding the components up ' +
            'myself.'),
      fields: {
        total_receivables: knowsReceivablesLabel
          ? {
              valueAsPrinted: readsTotalColumn ? 9_113_704 : 7_204_118,
              unitsMultiplier: 1000,
              confidence: 'medium',
              sourcePage: 1,
              sourceText: 'Receivables, Net $7,204,118',
              reasoning: `${column}. Read from the label you confirmed means total receivables.`,
            }
          : {
              valueAsPrinted: null,
              unitsMultiplier: 1000,
              confidence: 'low',
              sourcePage: 1,
              sourceText: '',
              reasoning: `No combined receivables line in the ${column}; only the individual counterparty rows.`,
            },
        total_investments: {
          valueAsPrinted: readsTotalColumn ? 502_073_818 : 462_090_073,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: readsTotalColumn
            ? 'Total Investments $502,073,818'
            : 'Total Investments $462,090,073',
          reasoning: `Investments at Fair Value section, ${column}.`,
        },
        total_assets: {
          valueAsPrinted: readsTotalColumn ? 551_388_204 : 508_215_927,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: readsTotalColumn
            ? 'TOTAL ASSETS $551,388,204'
            : 'TOTAL ASSETS $508,215,927',
          reasoning: `${column}, before deferred outflows of resources.`,
        },
        total_liabilities: {
          valueAsPrinted: readsTotalColumn ? 106_927_440 : 98_831_325,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText: readsTotalColumn
            ? 'TOTAL LIABILITIES $106,927,440'
            : 'TOTAL LIABILITIES $98,831,325',
          reasoning: `${column}, before deferred inflows of resources.`,
        },
        net_position: {
          valueAsPrinted: readsTotalColumn ? 444_460_764 : 409_424_367,
          unitsMultiplier: 1000,
          confidence: 'high',
          sourcePage: 1,
          sourceText:
            'NET POSITION – RESTRICTED FOR PENSION, OTHER POST-EMPLOYMENT, REPLACEMENT BENEFITS AND PROGRAM ADMINISTRATION $' +
            (readsTotalColumn ? '444,460,764' : '409,424,367'),
          reasoning: `${column}. Labelled at length here, but it is the net position line.`,
        },
      },
    },
  };
}

/** The per-field descriptions the schema was built with, keyed by field. */
function describedFields(schema: Record<string, unknown>): Record<string, string> {
  const properties = (schema.properties as Record<string, { properties?: Record<string, { description?: string }> }>)
    ?.fields?.properties;
  const described: Record<string, string> = {};
  for (const [key, definition] of Object.entries(properties ?? {})) {
    described[key] = definition.description ?? '';
  }
  return described;
}

export type DiagnosisReply = {
  model: string;
  diagnosis: Diagnosis;
  usage: { inputTokens: number; outputTokens: number };
  fixture: boolean;
};

/**
 * Explains a batch of corrections. No documents attached — see diagnosisPrompt.
 *
 * Adaptive thinking and high effort: working out whether four corrections share
 * one cause, and how far that cause reaches, is the reasoning this whole project
 * is about. A cheap wrong answer here is worse than no answer, because a
 * confidently wrong lesson gets applied to every future document.
 */
export async function diagnose(
  prompt: string,
  attachments: Attachment[],
  schema: Record<string, unknown>,
): Promise<DiagnosisReply> {
  const response = await client().messages.create({
    model: model(),
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [...documentBlocks(attachments), { type: 'text', text: prompt }] }],
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
    diagnosis: JSON.parse(text) as Diagnosis,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    fixture: false,
  };
}

/**
 * A recorded diagnosis of the two corrections the extraction fixture invites:
 * the units mistake on total_investments, and the blank the model left.
 *
 * Two lessons rather than one, with different scopes, because a fixture where
 * everything shares a cause would hide the case the UI most has to handle —
 * several proposals, each needing its own decision.
 */
export async function diagnoseFixture(
  _prompt: string,
  _attachments: Attachment[],
  _schema: Record<string, unknown>,
): Promise<DiagnosisReply> {
  await sleep(fixtureDelayMs());

  return {
    model: 'claude-opus-5',
    fixture: true,
    usage: { inputTokens: 1_840, outputTokens: 410 },
    diagnosis: {
      summary:
        'Three separate things went wrong, and only two of them are worth remembering. ' +
        'I read the wrong column throughout, I did not recognise the label this ' +
        'statement uses for receivables, and one figure I simply mistyped.',
      lessons: [
        {
          id: 'lesson-column',
          type: 'wrong_source',
          scope: 'fund',
          fieldKeys: ['total_investments', 'total_assets', 'total_liabilities', 'net_position'],
          explanation:
            'Every figure you changed is the one printed in the Total column of the same ' +
            'rows I read. I chose PERF A because it was the largest plan, but you want ' +
            'the fund as a whole.',
          rule:
            'For this fund, read the Total column of the statement of fiduciary net ' +
            'position rather than an individual plan column.',
          unitsMultiplier: null,
          documentLabel: '',
          confidence: 'high',
        },
        {
          id: 'lesson-receivables',
          type: 'synonym',
          scope: 'fund',
          fieldKeys: ['total_receivables'],
          explanation:
            'I left this blank because I was looking for a line saying total receivables. ' +
            'The figure you entered is printed on the line labelled "Receivables, Net", ' +
            'which I did not recognise as the same thing.',
          rule: 'Treat "Receivables, Net" as the total receivables line for this fund.',
          unitsMultiplier: null,
          documentLabel: 'Receivables, Net',
          confidence: 'high',
        },
        {
          id: 'lesson-slip',
          type: 'typo',
          scope: 'none',
          fieldKeys: [],
          explanation:
            'The last digit you changed does not correspond to anything else on the page. ' +
            'I think I simply transcribed it wrongly, which is not a pattern.',
          rule: '',
          unitsMultiplier: null,
          documentLabel: '',
          confidence: 'medium',
        },
      ],
    },
  };
}
