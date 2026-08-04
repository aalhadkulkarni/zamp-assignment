import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './config.js';
import { getPool } from './db.js';
import { startTestDatabase } from './testing.js';

/**
 * The Anthropic SDK is stubbed for every test in this file. The upload route
 * calls the model, and a test suite that spends tokens on each run is a test
 * suite people stop running.
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

/**
 * The customer's service is stubbed. Standing a second HTTP server up for every
 * upload test would be testing their code, not ours.
 */
const FIELD_DEFINITIONS = [
  { key: 'total_investments', label: 'Total Investments', type: 'money', unit: 'USD', required: true, description: 'Total investments held at fair value.' },
  { key: 'net_position', label: 'Net Position Restricted for Pensions', type: 'money', unit: 'USD', required: true, description: 'Net position restricted for pension benefits.' },
];

const createReport = vi.fn();

vi.mock('./customer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./customer.js')>()),
  listFieldDefinitions: vi.fn(async () => FIELD_DEFINITIONS),
  listFunds: vi.fn(async () => [
    { id: 'calpers', name: 'CalPERS — California Public Employees’ Retirement System' },
    // A second fund, so scope has something to be kept away from.
    { id: 'calstrs', name: 'CalSTRS — California State Teachers’ Retirement System' },
  ]),
  createReport: (...args: unknown[]) => createReport(...args),
}));

/**
 * These run against a listening server rather than app.inject, because the thing
 * under test is multipart parsing. Hand-building a multipart body to feed inject
 * would mean testing our own encoder as much as the endpoint.
 */
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

const TENANT = 'demo-tenant';
/** Created fresh per test, because an analysis row now has to exist first. */
let ANALYSIS: string;

beforeAll(async () => {
  await startTestDatabase();

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  create.mockReset();
  createReport.mockReset();
  createReport.mockResolvedValue({ ok: true, report: { id: 'report-1' } });
  delete process.env.USE_FIXTURES;
  // The fixture's delay simulates a real call for the UI's benefit. Paying it
  // on every assertion would just make the suite slower.
  process.env.FIXTURE_DELAY_MS = '0';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  create.mockResolvedValue(EXTRACTION_REPLY);
});

beforeEach(async () => {
  // A clean database per test: analyses cascade, so one delete clears the lot.
  await getPool().query('DELETE FROM analysis');
  await getPool().query('DELETE FROM lesson');

  const res = await app.inject({
    method: 'POST',
    url: '/analyses',
    payload: { fundId: 'calpers' },
  });
  ANALYSIS = res.json().id;
});



/** Printed in thousands, as the document prints it, so units are exercised. */
const EXTRACTION = {
  summary: 'I found the investments total. Net position was not on these pages.',
  fields: {
    total_investments: {
      valueAsPrinted: 462_090_073,
      unitsMultiplier: 1000,
      confidence: 'high',
      sourcePage: 1,
      sourceText: 'Total Investments $462,090,073',
      reasoning: 'Investments at Fair Value, PERF A column.',
    },
    net_position: {
      valueAsPrinted: null,
      unitsMultiplier: 1000,
      confidence: 'low',
      sourcePage: null,
      sourceText: '',
      reasoning: 'Not present on the supplied pages.',
    },
  },
};

/**
 * The arguments the SDK was called with most recently. `.at(-1)` is typed as
 * possibly undefined, which is true in general and never true here — every
 * caller has just made the call it is asking about.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is stubbed here;
   the assertions in each test are the check, and modelling the request shape
   would be friction that catches nothing. */
function lastCall(): { messages: any; output_config: any } {
  const call = create.mock.calls.at(-1);
  if (!call) throw new Error('The model was never called.');
  return call[0];
}

const EXTRACTION_REPLY = {
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
  usage: { input_tokens: 24180, output_tokens: 742 },
};

function pdf(name: string, size = 64): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

/**
 * The stubbed SDK error classes take just a status, where the real ones take
 * several arguments. The cast is the seam between the two.
 */
async function sdkError(
  kind: 'APIError' | 'AuthenticationError' | 'RateLimitError',
  status: number,
): Promise<Error> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const Stub = Anthropic[kind] as unknown as new (status: number) => Error;
  return new Stub(status);
}

async function upload(
  files: File[],
  {
    prompt,
    analysisId = ANALYSIS,
    fundId = 'calpers',
  }: { prompt?: string; analysisId?: string; fundId?: string | null } = {},
) {
  const form = new FormData();
  if (prompt !== undefined) form.set('prompt', prompt);
  if (fundId !== null) form.set('fundId', fundId);
  for (const file of files) form.append('documents', file, file.name);

  const response = await fetch(`${baseUrl}/analyses/${analysisId}/documents`, {
    method: 'POST',
    body: form,
  });
  const body = await response.json();

  // The upload now answers before the extraction runs, so a test that wants to
  // assert on what was extracted has to wait for it. Settling here rather than
  // in each test keeps every assertion about the outcome rather than the timing.
  const analysis = response.status === 202 ? await settled(body.analysisId) : null;
  return { status: response.status, body, analysis };
}

/**
 * Waits for the background extraction to stop running, and returns the analysis.
 *
 * Polled rather than awaiting the change notification, because with a zero
 * fixture delay the extraction can finish before the upload's own response has
 * been read — and a listener attached after the fact waits forever.
 */
async function settled(analysisId: string, job: 'extraction' | 'diagnosis' = 'extraction') {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const res = await app.inject({ method: 'GET', url: `/analyses/${analysisId}` });
    const analysis = res.json();
    if (analysis[job]?.state !== 'running') return analysis;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The ${job} never finished.`);
}

/** The agent's last word, which used to arrive in the upload's own response. */
type StoredMessage = {
  author: string;
  text: string;
  variant?: string;
  fixture?: boolean;
};

function lastAgentMessage(analysis: { messages: StoredMessage[] }) {
  return [...analysis.messages].reverse().find((m) => m.author === 'agent');
}

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'agent-api' });
  });
});

describe('POST /analyses/:analysisId/documents', () => {
  it('stores the documents and reports what it kept', async () => {
    const { status, body } = await upload([pdf('acfr.pdf', 128), pdf('notes.md', 32)]);

    expect(status).toBe(202);
    expect(body.analysisId).toBe(ANALYSIS);
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.documents).toEqual([
      { id: expect.any(String), filename: 'acfr.pdf', size: 128 },
      { id: expect.any(String), filename: 'notes.md', size: 32 },
    ]);
  });

  /**
   * Names are no longer altered. Sanitising them was about stopping a filename
   * steering a write out of its directory; the bytes are in a column now, so
   * there is no path to steer and no reason to show an analyst a name they did
   * not choose.
   */
  it('keeps the name the analyst gave the file', async () => {
    const { body } = await upload([
      new File([new Uint8Array(64)], 'AllTeams - GW2 (1).pdf', { type: 'application/pdf' }),
    ]);

    expect(body.documents[0].filename).toBe('AllTeams - GW2 (1).pdf');

    const [{ messages }] = create.mock.calls[0];
    const attached = messages[0].content.find((b: { type: string }) => b.type === 'document');
    expect(attached.title).toBe('AllTeams - GW2 (1).pdf');
  });

  it('stores the bytes themselves, not a path to them', async () => {
    await upload([pdf('acfr.pdf', 128)]);

    const { rows } = await getPool().query(
      'SELECT filename, size_bytes, bytes FROM document WHERE analysis_id = $1',
      [ANALYSIS],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('acfr.pdf');
    // Byte-identical, because the diagnosis reads these back to look at the page.
    expect(Buffer.isBuffer(rows[0].bytes)).toBe(true);
    expect(rows[0].bytes.length).toBe(128);
    expect(rows[0].size_bytes).toBe(128);
  });

  it('keeps the analyst note as part of the conversation', async () => {
    await upload([pdf('acfr.pdf')], {
      prompt: 'Figures in the net position table are in thousands.',
    });

    // It was a field in a manifest file; it is a message now, which is what it
    // always was — something the analyst said.
    const { rows } = await getPool().query(
      "SELECT body, attachments FROM message WHERE analysis_id = $1 AND author = 'analyst'",
      [ANALYSIS],
    );
    expect(rows[0].body).toBe('Figures in the net position table are in thousands.');
    expect(rows[0].attachments).toEqual([{ name: 'acfr.pdf', size: 64 }]);
  });

  it('accepts an upload with no prompt', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')]);
    expect(status).toBe(202);
    expect(body.prompt).toBe('');
  });

  it('refuses an upload with no documents', async () => {
    const { status, body } = await upload([], { prompt: 'anything' });
    expect(status).toBe(400);
    expect(body.error).toBe('NoDocuments');
  });

  it('refuses an analysis id that is not a uuid, before touching the filesystem', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')], { analysisId: 'not-a-uuid' });
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidAnalysisId');
  });

  it('rejects the whole upload if any document is unacceptable', async () => {
    const { status, body } = await upload([
      pdf('good.pdf'),
      new File([new Uint8Array(64)], 'bad.docx'),
    ]);

    expect(status).toBe(400);
    expect(body.error).toBe('UnacceptableDocuments');
    expect(body.rejected).toEqual([
      { filename: 'bad.docx', reason: expect.stringMatching(/Unsupported file type/) },
    ]);

    // Nothing was stored, including the document that was fine on its own.
    const { rows } = await getPool().query('SELECT 1 FROM document WHERE analysis_id = $1', [
      ANALYSIS,
    ]);
    expect(rows).toHaveLength(0);
  });

  /**
   * The browser blocks this, so it only happens when something other than our UI
   * is calling. It has to fail on the server too.
   */
  it('rejects a document over the size limit', async () => {
    const { status, body } = await upload([pdf('huge.pdf', MAX_FILE_BYTES + 1024)]);
    expect(status).toBe(413);
    expect(body.error).toBe('FileTooLarge');
  });

  it('rejects more documents than the per-upload limit', async () => {
    const files = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => pdf(`p${i}.pdf`));
    const { status, body } = await upload(files);
    expect(status).toBe(413);
    expect(body.error).toBe('TooManyFiles');
  });

  it('refuses a request that is not multipart', async () => {
    const response = await fetch(`${baseUrl}/analyses/${ANALYSIS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(response.status).toBe(415);
  });

  /**
   * 202, not 200. The documents are stored and the work has started, which is a
   * different promise from "here is your answer" — and the difference is the
   * whole reason the composer no longer waits on a model call.
   */
  it('accepts the upload before the extraction has run', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')]);

    expect(status).toBe(202);
    expect(body).toMatchObject({ analysisId: ANALYSIS, uploadId: expect.any(String) });
    // Nothing about what was found: that is not known yet.
    expect(body.agent).toBeUndefined();
  });

  /** The analyst's own message is a thing that has already happened. */
  it('records what the analyst sent before the agent has answered', async () => {
    let released!: () => void;
    const held = new Promise<void>((resolve) => {
      released = resolve;
    });
    create.mockImplementationOnce(async () => {
      await held;
      return EXTRACTION_REPLY;
    });

    await new Promise<void>((done) => {
      const form = new FormData();
      form.set('fundId', 'calpers');
      form.set('prompt', 'Statement of fiduciary net position.');
      form.append('documents', pdf('acfr.pdf'), 'acfr.pdf');
      void fetch(`${baseUrl}/analyses/${ANALYSIS}/documents`, { method: 'POST', body: form })
        .then(() => done());
    });

    const midFlight = (await app.inject({ method: 'GET', url: `/analyses/${ANALYSIS}` })).json();
    expect(midFlight.extraction.state).toBe('running');
    expect(midFlight.messages.at(-1)).toMatchObject({
      author: 'analyst',
      text: 'Statement of fiduciary net position.',
    });

    released();
    await settled(ANALYSIS);
  });

  it('extracts the rows and says what it found', async () => {
    const { analysis } = await upload([pdf('acfr.pdf')]);

    expect(analysis.extraction).toEqual({ state: 'idle', error: null });
    expect(lastAgentMessage(analysis)?.text).toContain('investments total');
    expect(analysis.fields).toHaveLength(2);
  });

  /**
   * The model reports the printed figure and the multiplier; the multiplication
   * is ours. This is the assertion that keeps it that way.
   */
  it('applies the document units rather than asking the model to', async () => {
    const { analysis } = await upload([pdf('acfr.pdf')]);

    const investments = analysis.fields.find((f: { key: string }) => f.key === 'total_investments');
    expect(investments.valueAsPrinted).toBe(462_090_073);
    expect(investments.unitsMultiplier).toBe(1000);
    expect(investments.value).toBe(462_090_073_000);
  });

  it('leaves a value the model could not find as null, not zero', async () => {
    const { analysis } = await upload([pdf('acfr.pdf')]);

    const missing = analysis.fields.find((f: { key: string }) => f.key === 'net_position');
    expect(missing.value).toBeNull();
    expect(missing.confidence).toBe('low');
  });

  it('asks the model only for fields the customer actually publishes', async () => {
    await upload([pdf('acfr.pdf')]);

    const [{ output_config }] = create.mock.calls[0];
    const fields = output_config.format.schema.properties.fields;
    // One named property per field means the model can neither invent a field
    // for customer-system to reject three steps later, nor quietly omit one.
    expect(Object.keys(fields.properties)).toEqual(['total_investments', 'net_position']);
    expect(fields.required).toEqual(['total_investments', 'net_position']);
    expect(fields.additionalProperties).toBe(false);
  });

  it('refuses an upload that does not say which fund it is for', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')], { fundId: null });

    expect(status).toBe(400);
    expect(body.error).toBe('MissingFund');
    expect(create).not.toHaveBeenCalled();
  });

  it('attaches the documents and quotes the analyst note', async () => {
    await upload([pdf('acfr.pdf'), pdf('notes.md')], {
      prompt: 'Figures are in thousands.',
    });

    const [{ messages }] = create.mock.calls[0];
    const blocks = messages[0].content;

    // The PDF goes as a document block; text files go inline.
    expect(blocks.filter((b: { type: string }) => b.type === 'document')).toHaveLength(1);
    const instruction = blocks.at(-1);
    expect(instruction.text).toContain('Figures are in thousands.');
    expect(instruction.text).toContain('CalPERS');
  });

  /**
   * The documents are already on disk when the model is called. Reporting a
   * model failure as a failed upload would make the analyst re-send files we
   * already have, and could leave a second copy behind.
   */
  describe('when the model call fails', () => {
    async function failWith(error: unknown) {
      create.mockRejectedValue(error);
      return upload([pdf('acfr.pdf', 128)]);
    }

    it('still reports the upload as accepted, and records why the reading failed', async () => {
      const { status, body, analysis } = await failWith(await sdkError('RateLimitError', 429));

      // The documents are safe, which is what the upload was about.
      expect(status).toBe(202);
      expect(body.documents).toHaveLength(1);

      // The failure belongs to the extraction, and is on the analysis.
      expect(analysis.extraction.state).toBe('failed');
      expect(analysis.extraction.error).toMatch(/rate limiting/i);
    });

    /**
     * The browser is waiting on a notification, not a response. A failure that
     * only reached a log would leave it waiting forever, so it has to arrive by
     * the same route a success does.
     */
    it('tells the analyst in the conversation, not only in the state', async () => {
      const { analysis } = await failWith(await sdkError('RateLimitError', 429));

      const said = lastAgentMessage(analysis);
      expect(said?.variant).toBe('error');
      expect(said?.text).toContain('Your documents are stored');
      expect(said?.text).toMatch(/rate limiting/i);
    });

    it('still stores the documents', async () => {
      await failWith(await sdkError('APIError', 529));

      const { rows } = await getPool().query(
        'SELECT filename FROM document WHERE analysis_id = $1',
        [ANALYSIS],
      );
      expect(rows.map((r) => r.filename)).toEqual(['acfr.pdf']);
    });

    it('names a missing API key rather than blaming the upload', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { status, body, analysis } = await upload([pdf('acfr.pdf')]);

      expect(status).toBe(202);
      expect(body.documents).toHaveLength(1);
      expect(analysis.extraction.error).toMatch(/no Anthropic API key/i);
    });

    it('reports a refusal as its own outcome', async () => {
      create.mockResolvedValue({
        model: 'claude-opus-5',
        stop_reason: 'refusal',
        content: [],
        stop_details: { category: 'cyber' },
        usage: { input_tokens: 5, output_tokens: 0 },
      });

      const { analysis } = await upload([pdf('acfr.pdf')]);
      expect(analysis.extraction.state).toBe('failed');
      expect(analysis.extraction.error).toMatch(/declined to answer/i);
    });

    /** Failed, not stuck. A spinner with nothing behind it is the worst outcome. */
    it('never leaves the extraction running after a failure', async () => {
      const { analysis } = await failWith(new Error('something nobody predicted'));
      expect(analysis.extraction.state).toBe('failed');
      expect(analysis.extraction.error).toBeTruthy();
    });
  });

  /**
   * The point of fixture mode is that development and tests cost nothing, so
   * the assertion that matters is that no request is made at all.
   */
  describe('fixture mode', () => {
    it('answers from the recording without calling the API', async () => {
      process.env.USE_FIXTURES = 'true';
      const { status, analysis } = await upload([pdf('acfr.pdf')]);

      expect(status).toBe(202);
      expect(lastAgentMessage(analysis)?.fixture).toBe(true);
      expect(lastAgentMessage(analysis)?.text).toMatch(/statement of fiduciary net position/i);
      expect(analysis.fields).toHaveLength(5);
      expect(create).not.toHaveBeenCalled();
    });

    it('works with no API key at all', async () => {
      process.env.USE_FIXTURES = 'true';
      delete process.env.ANTHROPIC_API_KEY;

      const { status, analysis } = await upload([pdf('acfr.pdf')]);
      expect(status).toBe(202);
      expect(analysis.extraction).toEqual({ state: 'idle', error: null });
      expect(lastAgentMessage(analysis)?.fixture).toBe(true);
    });

    it('still stores the documents', async () => {
      process.env.USE_FIXTURES = 'true';
      await upload([pdf('acfr.pdf', 128)]);

      const { rows } = await getPool().query('SELECT filename FROM document WHERE analysis_id = $1', [
        ANALYSIS,
      ]);
      expect(rows.map((r) => r.filename)).toEqual(['acfr.pdf']);
    });

    it('is off unless explicitly switched on', async () => {
      const { analysis } = await upload([pdf('acfr.pdf')]);

      expect(lastAgentMessage(analysis)?.fixture).toBeUndefined();
      expect(create).toHaveBeenCalledOnce();
    });

    it('is not switched on by a value that merely looks truthy', async () => {
      process.env.USE_FIXTURES = '1';
      const { analysis } = await upload([pdf('acfr.pdf')]);

      expect(lastAgentMessage(analysis)?.fixture).toBeUndefined();
      expect(create).toHaveBeenCalledOnce();
    });
  });

  /**
   * A filename is data now, not a path — it is a column value and cannot steer
   * anything. The multipart layer happens to strip the directory part before we
   * ever see it, which is belt to our braces rather than something we rely on.
   */
  it('accepts a document whose name looks like a path traversal', async () => {
    const { status, body } = await upload([
      new File([new Uint8Array(64)], '../../../etc/passwd.pdf', { type: 'application/pdf' }),
    ]);

    expect(status).toBe(202);
    expect(body.documents[0].filename).not.toContain('..');
  });
});


describe('POST /analyses/:analysisId/report', () => {
  // `object`, not `unknown` — inject's payload is typed, and unknown breaks the
  // overload, which then makes statusCode and json() look like they don't exist.
  async function write(body: object) {
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/report`,
      payload: body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  const REPORT = {
    fundId: 'calpers',
    fiscalYearEnd: '2025-06-30',
    values: { total_investments: '462090073000', net_position: '409424367000' },
  };

  it('writes the values to the customer system', async () => {
    const { status } = await write(REPORT);

    expect(status).toBe(201);
    expect(createReport).toHaveBeenCalledWith('calpers', '2025-06-30', {
      total_investments: 462_090_073_000,
      net_position: 409_424_367_000,
    });
  });

  /**
   * A money field holding text is forwarded as text rather than converted to
   * NaN, so their schema is the thing that refuses it and the analyst is told
   * what is actually wrong.
   */
  it('forwards a value it cannot convert rather than guessing', async () => {
    await write({
      ...REPORT,
      values: { ...REPORT.values, total_investments: 'see note 7' },
    });

    expect(createReport.mock.calls[0][2].total_investments).toBe('see note 7');
  });

  /** Absent and blank are different claims; their schema decides about absent. */
  it('omits a value the analyst left empty', async () => {
    await write({ ...REPORT, values: { ...REPORT.values, net_position: '   ' } });

    expect(createReport.mock.calls[0][2]).not.toHaveProperty('net_position');
  });

  it('passes the rejection through with its status and per-field reasons', async () => {
    createReport.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'ValidationFailed',
      message: 'The report was not stored.',
      problems: [{ field: 'total_investments', reason: 'Must be a whole number of USD.' }],
    });

    const { status, body } = await write(REPORT);

    // Their wording, their status. Rewording it would put us between the
    // analyst and the system that actually refused.
    expect(status).toBe(400);
    expect(body).toEqual({
      error: 'ValidationFailed',
      message: 'The report was not stored.',
      problems: [{ field: 'total_investments', reason: 'Must be a whole number of USD.' }],
    });
  });

  it('passes a duplicate report through as a conflict', async () => {
    createReport.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'ReportAlreadyExists',
      message: 'A report for calpers ending 2025-06-30 is already on file.',
    });

    const { status, body } = await write(REPORT);
    expect(status).toBe(409);
    expect(body.error).toBe('ReportAlreadyExists');
    expect(body.problems).toEqual([]);
  });

  it('reports an unreachable customer system as a gateway failure', async () => {
    const { CustomerSystemError } = await import('./customer.js');
    createReport.mockRejectedValue(new CustomerSystemError('The customer system could not be reached.', 0));

    const { status, body } = await write(REPORT);
    expect(status).toBe(502);
    expect(body.error).toBe('CustomerSystemUnavailable');
  });

  it('refuses a request missing the fund or the period', async () => {
    expect((await write({ ...REPORT, fundId: undefined })).status).toBe(400);
    expect((await write({ ...REPORT, fiscalYearEnd: undefined })).status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });
});

describe('POST /analyses/:analysisId/edits', () => {
  const EDIT = {
    id: 'edit-1',
    fieldKey: 'total_investments',
    from: '462090073000',
    to: '462090073',
    at: '2026-08-04T10:00:00.000Z',
    context: {
      sourceText: 'Total Investments $462,090,073',
      sourcePage: 1,
      confidence: 'high',
      reasoning: 'PERF A column.',
    },
  };

  /**
   * Submits corrections and waits for the explanation, which now runs after the
   * request has been answered. Settling here keeps each assertion about the
   * outcome rather than about the timing.
   */
  async function submit(body: object, analysisId = ANALYSIS) {
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${analysisId}/edits`,
      payload: body,
    });
    const analysis =
      res.statusCode === 202 ? await settled(analysisId, 'diagnosis') : null;
    return { status: res.statusCode, body: res.json(), analysis };
  }

  const DIAGNOSIS_REPLY = {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          summary: 'You scaled a figure that was already in whole dollars.',
          lessons: {
            total_investments: {
              type: 'units',
              scope: 'fund',
              sharedWith: [],
              explanation: 'The heading said thousands but this section did not follow it.',
              rule: 'Check whether the investments section restates its units.',
              unitsMultiplier: 1,
              documentLabel: '',
              confidence: 'medium',
            },
          },
        }),
      },
    ],
    usage: { input_tokens: 1840, output_tokens: 410 },
  };

  beforeEach(() => {
    create.mockResolvedValue(DIAGNOSIS_REPLY);
  });

  it('stores the batch and says how many it took', async () => {
    const { status, body } = await submit({ fundId: 'calpers', edits: [EDIT, { ...EDIT, id: 'edit-2', fieldKey: 'net_position' }] });

    // 202: recorded and being looked at. What caused them is not known yet.
    expect(status).toBe(202);
    expect(body).toMatchObject({ batchId: expect.any(String), received: 2 });
    expect(body.diagnosis).toBeUndefined();
  });

  describe('the diagnosis', () => {
    it('asks the model why, and puts what it proposed on the analysis', async () => {
      const { analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(analysis.diagnosis).toEqual({ state: 'idle', error: null });
      expect(lastAgentMessage(analysis)?.text).toMatch(/already in whole dollars/);
      expect(analysis.lessons).toHaveLength(1);
      expect(analysis.lessons[0]).toMatchObject({
        type: 'units',
        scope: 'fund',
        fieldKey: 'total_investments',
      });
    });

    /** An accept has to name exactly one lesson, and a model inventing ids is a
     *  way to get collisions and dangling references for no benefit. */
    it('assigns the lesson ids itself', async () => {
      const { analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });
      expect(analysis.lessons[0].id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('sends the correction and the provenance it was captured with', async () => {
      await submit({ fundId: 'calpers', edits: [EDIT] });

      const [{ messages }] = create.mock.calls[0];
      const prompt = messages[0].content.at(-1).text;

      expect(prompt).toContain('462090073000');
      expect(prompt).toContain('462090073');
      expect(prompt).toContain('Total Investments $462,090,073');
      expect(prompt).toContain('PERF A column.');
    });

    /**
     * Three of the five lesson types are about what else was on the page — a
     * figure from the wrong column, a similarly-labelled different concept, a
     * label not recognised at all. None of them is visible in the one line the
     * model quoted, so the page has to come too.
     */
    it('attaches the pages the analyst was reviewing', async () => {
      await upload([pdf('acfr.pdf', 128)]);
      create.mockClear();
      create.mockResolvedValue(DIAGNOSIS_REPLY);

      await submit({ fundId: 'calpers', edits: [EDIT] });

      const [{ messages }] = create.mock.calls[0];
      const attached = messages[0].content.filter((b: { type: string }) => b.type === 'document');
      expect(attached).toHaveLength(1);
      expect(attached[0].title).toBe('acfr.pdf');
    });

    it('tells the model not to extract again', async () => {
      await submit({ fundId: 'calpers', edits: [EDIT] });

      const [{ messages }] = create.mock.calls[0];
      // Without this the attached pages invite a second extraction instead of
      // an explanation of the first.
      expect(messages[0].content.at(-1).text).toMatch(/not extracting again/i);
    });

    /** Render wipes the upload directory on every restart. A diagnosis without
     *  the page is worse than one with it, and far better than a failure. */
    it('still diagnoses when the documents are no longer on disk', async () => {
      const { status, analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(status).toBe(202);
      expect(analysis.lessons).toHaveLength(1);
      const [{ messages }] = create.mock.calls[0];
      expect(messages[0].content.filter((b: { type: string }) => b.type === 'document')).toHaveLength(0);
    });

    it('constrains the lessons to fields that were actually corrected', async () => {
      await submit({ fundId: 'calpers', edits: [EDIT] });

      const [{ output_config }] = create.mock.calls[0];
      const lessons = output_config.format.schema.properties.lessons;
      // One named property per corrected field: every correction gets exactly
      // one verdict, and none can cover two fields at once.
      expect(Object.keys(lessons.properties)).toEqual(['total_investments']);
      expect(lessons.required).toEqual(['total_investments']);
      expect(lessons.additionalProperties).toBe(false);
    });

    /** The corrections are the raw material. Losing them because the
     *  explanation failed would be the expensive half of the mistake. */
    it('keeps the corrections when the diagnosis fails', async () => {
      create.mockRejectedValue(await sdkError('RateLimitError', 429));

      const { status, body, analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });

      // Accepted, because they were stored before anything could fail.
      expect(status).toBe(202);
      expect(body.batchId).toEqual(expect.any(String));

      expect(analysis.diagnosis.state).toBe('failed');
      expect(analysis.diagnosis.error).toMatch(/rate limiting/i);
      expect(lastAgentMessage(analysis)?.text).toContain('Your corrections are recorded');

      const { rows } = await getPool().query('SELECT 1 FROM correction WHERE analysis_id = $1', [
        ANALYSIS,
      ]);
      expect(rows).toHaveLength(1);
    });

    /**
     * The recording reads the corrections it was given rather than returning a
     * fixed answer. It used to propose the same three lessons whatever had been
     * changed, which meant the cards named fields nobody had touched.
     */
    it('answers from the recording, about the corrections actually made', async () => {
      process.env.USE_FIXTURES = 'true';
      const { analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(create).not.toHaveBeenCalled();
      expect(analysis.lessons).toHaveLength(1);
      // EDIT moves 462090073000 to 462090073 — a clean factor of a thousand.
      expect(analysis.lessons[0]).toMatchObject({
        type: 'units',
        fieldKey: 'total_investments',
        unitsMultiplier: 1000,
      });
    });

    /**
     * A shared cause is reported, not bundled. One card per correction, so an
     * analyst who agrees about one field and not the other can say so — a single
     * card covering both would force them to reject the part that was right.
     */
    it('proposes one lesson per correction, and names the shared cause on each', async () => {
      process.env.USE_FIXTURES = 'true';
      const { analysis } = await submit({
        fundId: 'calpers',
        edits: [EDIT, { ...EDIT, id: 'e2', fieldKey: 'net_position', from: '5000', to: '5' }],
      });

      expect(analysis.lessons).toHaveLength(2);
      expect(analysis.lessons.map((l: { fieldKey: string }) => l.fieldKey)).toEqual([
        'total_investments',
        'net_position',
      ]);
      // Each knows the other moved for the same reason, without deciding for it.
      expect(analysis.lessons[0].sharedWith).toEqual(['net_position']);
      expect(analysis.lessons[1].sharedWith).toEqual(['total_investments']);
    });

    /** Never a lesson about a field the analyst did not touch. */
    it('never names a field that was not corrected', async () => {
      process.env.USE_FIXTURES = 'true';
      const { analysis } = await submit({ fundId: 'calpers', edits: [EDIT] });

      const named = analysis.lessons.map((l: { fieldKey: string }) => l.fieldKey);
      expect(new Set(named)).toEqual(new Set(['total_investments']));
    });
  });

  /**
   * One file for the whole batch, not one per field. Corrections made together
   * are the evidence that they share a cause — five values changed by the same
   * factor is one mistake about units, and splitting them loses that.
   */
  it('records the corrections as one batch, with their provenance', async () => {
    const { body } = await submit({ fundId: 'calpers', edits: [EDIT] });

    const { rows } = await getPool().query(
      'SELECT batch_id, from_value, to_value, context FROM correction WHERE analysis_id = $1',
      [ANALYSIS],
    );

    expect(rows).toHaveLength(1);
    // The batch id ties corrections made together to the one diagnosis of them.
    expect(rows[0].batch_id).toBe(body.batchId);
    expect(rows[0].from_value).toBe('462090073000');
    expect(rows[0].context.sourceText).toBe('Total Investments $462,090,073');
  });

  /** The analyst agreeing with us is a normal outcome, not a failure. */
  it('accepts an empty batch without writing anything', async () => {
    const { status, body } = await submit({ fundId: 'calpers', edits: [] });

    expect(status).toBe(200);
    expect(body).toMatchObject({ batchId: null, received: 0, diagnosis: null });
    const { rows } = await getPool().query('SELECT 1 FROM correction WHERE analysis_id = $1', [
      ANALYSIS,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('refuses an analysis id that could steer a filesystem path', async () => {
    const { status } = await submit({ fundId: 'calpers', edits: [EDIT] }, 'not-a-uuid');
    expect(status).toBe(400);
  });

  /**
   * The table has to show what was agreed, not what was proposed. Left as the
   * model's reading it says "not found" for a value the customer now holds.
   */
  it('shows the corrected value once corrections are submitted', async () => {
    // The extraction first, then the diagnosis — this describe defaults to the
    // latter, so the upload needs the former put back.
    create.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    await upload([pdf('acfr.pdf')]);

    const before = await app.inject({ method: 'GET', url: `/analyses/${ANALYSIS}` });
    expect(
      before.json().fields.find((f: { key: string }) => f.key === 'net_position').value,
    ).toBeNull();

    await submit({
      fundId: 'calpers',
      edits: [{ ...EDIT, fieldKey: 'net_position', from: '', to: '409424367000' }],
    });

    const after = await app.inject({ method: 'GET', url: `/analyses/${ANALYSIS}` });
    const field = after.json().fields.find((f: { key: string }) => f.key === 'net_position');
    expect(field.value).toBe(409424367000);
    // The provenance still describes the model's reading — that is how you check
    // the value against the page.
    expect(field.reasoning).toBe('Not present on the supplied pages.');
  });

  it('refuses a batch that does not say which fund it belongs to', async () => {
    const { status, body } = await submit({ edits: [EDIT] });
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidRequest');
  });
});

/**
 * The payoff, end to end: a correction on one document changes how the next one
 * is read. Each test teaches one lesson type and then asserts it arrived at its
 * own point in the pipeline — the output schema, the prompt, or the arithmetic.
 * A single "it all goes in the prompt" implementation would fail four of these.
 */
describe('applying what was learned', () => {
  const EDIT = {
    id: 'edit-1',
    fieldKey: 'total_investments',
    from: '462090073000',
    to: '462090073',
    at: '2026-08-04T10:00:00.000Z',
    context: {
      sourceText: 'Total Investments $462,090,073',
      sourcePage: 1,
      confidence: 'high',
      reasoning: 'PERF A column.',
    },
  };

  /**
   * The whole loop as an analyst walks it: correct, receive a diagnosis, ratify
   * it. Nothing here reaches into the database — a lesson that only applies
   * because a test inserted it would prove nothing about the route that stores
   * one.
   */
  async function ratify(proposed: Record<string, unknown>, decision = 'accepted') {
    create.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: 'Here is what I think went wrong.',
            lessons: { [proposed.fieldKey as string]: proposed },
          }),
        },
      ],
      usage: { input_tokens: 1840, output_tokens: 410 },
    });

    await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/edits`,
      payload: { fundId: 'calpers', edits: [EDIT] },
    });
    // The proposal lands on the analysis after the request is answered.
    const [lesson] = (await settled(ANALYSIS, 'diagnosis')).lessons;

    await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/lessons/${lesson.id}`,
      payload: { decision },
    });
    return lesson;
  }

  /** A second analysis, for the same fund, as a fresh document would arrive. */
  async function nextDocument(fundId = 'calpers') {
    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { fundId },
    });
    create.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const { analysis } = await upload([pdf('next-year.pdf')], {
      analysisId: created.json().id,
      fundId,
    });
    const { messages, output_config } = lastCall();
    return {
      analysis,
      prompt: messages[0].content.at(-1).text,
      schema: output_config.format.schema,
    };
  }

  const SYNONYM = {
    type: 'synonym',
    scope: 'fund',
    fieldKey: 'net_position',
    sharedWith: [],
    explanation: 'This issuer prints it differently.',
    rule: 'Treat "Fiduciary Balance Carried Forward" as net position for this fund.',
    unitsMultiplier: null,
    documentLabel: 'Fiduciary Balance Carried Forward',
    confidence: 'high',
  };

  it('carries a ratified synonym into the field it belongs to', async () => {
    await ratify(SYNONYM);
    const { prompt, schema } = await nextDocument();

    expect(schema.properties.fields.properties.net_position.description).toContain(
      '"Fiduciary Balance Carried Forward"',
    );
    // The field it is not about is untouched, and the prompt never sees it.
    expect(schema.properties.fields.properties.total_investments.description).not.toContain(
      'Fiduciary Balance Carried Forward',
    );
    expect(prompt).not.toContain('Fiduciary Balance Carried Forward');
  });

  it('carries a concept confusion as the opposite instruction', async () => {
    await ratify({ ...SYNONYM, type: 'concept_confusion', documentLabel: 'Total Fund Balance' });
    const { schema } = await nextDocument();

    const description = schema.properties.fields.properties.net_position.description;
    expect(description).toContain('Do not read "Total Fund Balance"');
  });

  it('carries a source rule into the prompt, not the schema', async () => {
    await ratify({
      ...SYNONYM,
      type: 'wrong_source',
      rule: 'Read the Total column, not an individual plan column.',
      documentLabel: '',
    });
    const { prompt, schema } = await nextDocument();

    expect(prompt).toContain('Read the Total column');
    expect(JSON.stringify(schema)).not.toContain('Total column');
  });

  /**
   * The one that never reaches the model at all. A ratified multiplier is
   * arithmetic we do afterwards, so it holds whatever the model decides the
   * units heading says.
   */
  it('enforces a ratified units lesson after the model has answered', async () => {
    await ratify({ ...SYNONYM, fieldKey: 'total_investments', type: 'units', unitsMultiplier: 1, documentLabel: '' });
    const { analysis, prompt, schema } = await nextDocument();

    const investments = analysis.fields.find((f: { key: string }) => f.key === 'total_investments');
    // The model still said 1000. We did not ask it again; we overruled it.
    expect(investments.value).toBe(462_090_073);
    expect(investments.lessonNote).toMatch(/you confirmed/i);

    expect(prompt).not.toContain('confirmed these rules');
    expect(JSON.stringify(schema)).not.toContain('confirmed');
  });

  it('says in the chat what it applied', async () => {
    await ratify(SYNONYM);
    const { analysis } = await nextDocument();
    const agentSaid = lastAgentMessage(analysis)!.text;
    expect(agentSaid).toContain('1 label you told me to recognise');
    // Ahead of the findings, not buried after them.
    expect(agentSaid.indexOf('applied')).toBeLessThan(agentSaid.indexOf('I found'));
  });

  it('applies nothing until a human has ratified it', async () => {
    await ratify(SYNONYM, 'rejected');
    const { schema } = await nextDocument();

    expect(schema.properties.fields.properties.net_position.description).not.toContain(
      'Fiduciary Balance Carried Forward',
    );
  });

  /** Scope is the field deciding blast radius, so it has to actually bind. */
  it('keeps a fund-scoped lesson away from another fund', async () => {
    await ratify(SYNONYM);
    const { schema } = await nextDocument('calstrs');

    expect(schema.properties.fields.properties.net_position.description).not.toContain(
      'Fiduciary Balance Carried Forward',
    );
  });

  it('carries a global lesson to every fund', async () => {
    await ratify({ ...SYNONYM, scope: 'global' });
    const { schema } = await nextDocument('calstrs');

    expect(schema.properties.fields.properties.net_position.description).toContain(
      '"Fiduciary Balance Carried Forward"',
    );
  });

  /** A slip is not a rule. Nothing about a typo should survive the ratification. */
  it('learns nothing from a typo, even when accepted', async () => {
    await ratify({ ...SYNONYM, type: 'typo', scope: 'none', documentLabel: '', rule: '' });
    const { analysis, prompt, schema } = await nextDocument();

    expect(schema.properties.fields.properties.net_position.description).not.toContain('Fiduciary Balance');
    expect(prompt).not.toContain('confirmed these rules');
    expect(lastAgentMessage(analysis)?.text).not.toContain('you have confirmed');
  });

  it('survives a restart, because the lesson is in the database', async () => {
    await ratify(SYNONYM);

    const { rows } = await getPool().query(
      `SELECT type, scope, document_label, decision FROM lesson WHERE fund_id = 'calpers'`,
    );
    expect(rows).toEqual([
      {
        type: 'synonym',
        scope: 'fund',
        document_label: 'Fiduciary Balance Carried Forward',
        decision: 'accepted',
      },
    ]);
  });
});

/**
 * Which fund an analysis is for decides which ratified lessons reach it, so it
 * is the one fact a caller must not be able to restate. Both routes used to
 * take it from the request body, which made every scoping guarantee above
 * conditional on the client being honest.
 */
describe('the fund an analysis belongs to', () => {
  async function otherFund() {
    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { fundId: 'calstrs' },
    });
    return created.json().id;
  }

  it('refuses an upload that claims a different fund', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')], {
      analysisId: await otherFund(),
      fundId: 'calpers',
    });

    expect(status).toBe(409);
    expect(body.error).toBe('FundMismatch');
    expect(body.message).toContain('CalSTRS');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses corrections that claim a different fund', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${await otherFund()}/edits`,
      payload: {
        fundId: 'calpers',
        edits: [
          {
            id: 'e1',
            fieldKey: 'total_investments',
            from: '1',
            to: '2',
            at: '2026-08-04T10:00:00.000Z',
            context: { sourceText: '', sourcePage: 1, confidence: 'high', reasoning: '' },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('FundMismatch');
    // Nothing was stored against the fund the caller named.
    const { rows } = await getPool().query('SELECT id FROM lesson');
    expect(rows).toEqual([]);
  });

  it('refuses an upload to an analysis that does not exist', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')], {
      analysisId: crypto.randomUUID(),
    });

    expect(status).toBe(404);
    expect(body.error).toBe('UnknownAnalysis');
  });
});

/**
 * Raw correction history, sent alongside the ratified rules rather than instead
 * of them. Lessons are conclusions a human agreed to; these are the evidence,
 * and they carry the patterns no single per-batch diagnosis had enough
 * documents to see.
 */
describe('what the analyst has changed before', () => {
  const EDIT = {
    id: 'e1',
    fieldKey: 'total_investments',
    from: '462090073000',
    to: '462090073',
    at: '2026-08-04T10:00:00.000Z',
    context: {
      sourceText: 'Total Investments $462,090,073',
      sourcePage: 1,
      confidence: 'high',
      reasoning: 'PERF A column.',
    },
  };

  /** Correct something, then start a fresh analysis and read what it was sent. */
  async function afterCorrecting(fundId = 'calpers', nextFundId = fundId) {
    await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/edits`,
      payload: { fundId, edits: [EDIT] },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { fundId: nextFundId },
    });
    create.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    await upload([pdf('next.pdf')], { analysisId: created.json().id, fundId: nextFundId });

    const { messages } = lastCall();
    return messages[0].content.at(-1).text as string;
  }

  it('sends what was corrected, with the reasoning that produced it', async () => {
    const prompt = await afterCorrecting();

    expect(prompt).toContain('total_investments, corrected');
    expect(prompt).toContain('you extracted: 462090073000');
    expect(prompt).toContain('the analyst changed it to: 462090073');
    expect(prompt).toContain('your reasoning was: PERF A column.');
  });

  /**
   * The failure this block most invites: a list of correct-looking figures next
   * to their field names, in a prompt asking for figures. Every value belongs to
   * a different document, and saying so is the only thing standing between the
   * history and last year's numbers being copied forward.
   */
  it('says plainly that the figures belong to other documents', async () => {
    const prompt = await afterCorrecting();

    expect(prompt).toContain('different document covering a different period');
    expect(prompt).toContain('Do not carry any of these figures across');
  });

  /** Evidence and ratified rules are different claims and must read as such. */
  it('does not present a correction as something confirmed', async () => {
    const prompt = await afterCorrecting();

    const history = prompt.slice(prompt.indexOf('here is what the analyst changed'));
    expect(history).toContain('These are corrections, not rules');
    expect(history).toContain('nobody has confirmed what caused them');
  });

  it('keeps one fund’s corrections away from another', async () => {
    const prompt = await afterCorrecting('calpers', 'calstrs');

    expect(prompt).not.toContain('total_investments, corrected');
  });

  it('does not send an analysis its own corrections', async () => {
    await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/edits`,
      payload: { fundId: 'calpers', edits: [EDIT] },
    });
    // Re-uploading to the same analysis: these corrections are about the very
    // document being read again, not about a previous one.
    create.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    await upload([pdf('again.pdf')]);

    const { messages } = lastCall();
    expect(messages[0].content.at(-1).text).not.toContain('total_investments, corrected');
  });

  it('says nothing at all when there is no history', async () => {
    await upload([pdf('acfr.pdf')]);

    const [{ messages }] = create.mock.calls[0];
    expect(messages[0].content.at(-1).text).not.toContain('here is what the analyst changed');
  });

  /** An unbounded prompt stops working somewhere around the hundredth document. */
  it('caps the history at the twenty most recent', async () => {
    for (let i = 0; i < 25; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/analyses/${ANALYSIS}/edits`,
        payload: {
          fundId: 'calpers',
          edits: [{ ...EDIT, id: `e${i}`, to: String(i) }],
        },
      });
      // One diagnosis at a time, so a batch sent while the last is still being
      // explained is refused. Waiting is what an analyst would do anyway.
      await settled(ANALYSIS, 'diagnosis');
    }
    const prompt = await afterCorrecting();

    expect(prompt.match(/, corrected /g)).toHaveLength(20);
  });
});

/**
 * The stream the browser waits on instead of holding a request open.
 *
 * Read with fetch rather than EventSource, which does not exist in Node. What
 * matters here is the wire format, since that is the contract EventSource
 * parses — the event names and the blank line that terminates each frame.
 */
describe('GET /analyses/:analysisId/events', () => {
  async function openStream(analysisId = ANALYSIS) {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/analyses/${analysisId}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      /**
       * Reads until the wanted event name shows up, or gives up.
       *
       * The read is raced against the deadline rather than checked before it:
       * a stream with nothing to say leaves read() pending forever, so a loop
       * that only tests the clock between reads never gets to test it again.
       */
      async waitFor(event: string, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        let buffered = '';
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;

          const chunk = await Promise.race([
            reader.read(),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
          ]);
          if (chunk === 'timeout' || chunk.done) break;

          buffered += decoder.decode(chunk.value, { stream: true });
          if (buffered.includes(`event: ${event}`)) return buffered;
        }
        throw new Error(`Never saw "${event}". Got: ${JSON.stringify(buffered)}`);
      },
      close: () => controller.abort(),
    };
  }

  it('is an event stream, and says so before anything has happened', async () => {
    const stream = await openStream();

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');

    // Sent on connect, so the browser knows the stream is live rather than
    // inferring it from the absence of anything.
    const frame = await stream.waitFor('open');
    expect(frame).toContain(`"analysisId":"${ANALYSIS}"`);
    expect(frame.endsWith('\n\n')).toBe(true);

    stream.close();
  });

  /** The whole point: the result arrives without the client asking again. */
  it('announces the extraction finishing', async () => {
    const stream = await openStream();
    await stream.waitFor('open');

    await upload([pdf('acfr.pdf')]);

    const frame = await stream.waitFor('changed');
    expect(frame).toContain(`"analysisId":"${ANALYSIS}"`);
    stream.close();
  });

  /** A failed extraction has to wake the browser too, or it waits forever. */
  it('announces a failure the same way it announces a result', async () => {
    const stream = await openStream();
    await stream.waitFor('open');

    create.mockRejectedValue(await sdkError('RateLimitError', 429));
    await upload([pdf('acfr.pdf')]);

    expect(await stream.waitFor('changed')).toContain('changed');
    stream.close();
  });

  it('does not tell one analysis about another', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/analyses',
      payload: { fundId: 'calstrs' },
    });
    const stream = await openStream(other.json().id);
    await stream.waitFor('open');

    await upload([pdf('acfr.pdf')]);

    await expect(stream.waitFor('changed', 400)).rejects.toThrow(/Never saw/);
    stream.close();
  });

  it('refuses to stream an analysis that does not exist', async () => {
    const response = await fetch(`${baseUrl}/analyses/${crypto.randomUUID()}/events`);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('UnknownAnalysis');
  });
});

describe('one extraction at a time', () => {
  it('refuses a second upload while the first is still being read', async () => {
    let released!: () => void;
    const held = new Promise<void>((resolve) => {
      released = resolve;
    });
    create.mockImplementationOnce(async () => {
      await held;
      return EXTRACTION_REPLY;
    });

    const form = new FormData();
    form.set('fundId', 'calpers');
    form.set('prompt', '');
    form.append('documents', pdf('first.pdf'), 'first.pdf');
    await fetch(`${baseUrl}/analyses/${ANALYSIS}/documents`, { method: 'POST', body: form });

    const { status, body } = await upload([pdf('second.pdf')]);
    expect(status).toBe(409);
    expect(body.error).toBe('ExtractionInProgress');

    released();
    await settled(ANALYSIS);
  });

  /** Failed is a finished state; the analyst has to be able to try again. */
  it('allows another attempt once a failed one has finished', async () => {
    create.mockRejectedValueOnce(await sdkError('RateLimitError', 429));
    const first = await upload([pdf('acfr.pdf')]);
    expect(first.analysis.extraction.state).toBe('failed');

    const second = await upload([pdf('acfr.pdf')]);
    expect(second.status).toBe(202);
    expect(second.analysis.extraction.state).toBe('idle');
  });
});

/**
 * What the analyst changed belongs in the conversation, above the explanation of
 * why. Before this the corrections were only ever drawn from browser state
 * before they were submitted, so sending them made them vanish — leaving the
 * agent reasoning about an edit nothing on screen described.
 */
describe('the corrections in the conversation', () => {
  const EDIT = {
    id: 'e1',
    fieldKey: 'total_investments',
    from: '462090073000',
    to: '462090073',
    at: '2026-08-04T10:00:00.000Z',
    context: { sourceText: 'x', sourcePage: 1, confidence: 'high', reasoning: 'PERF A column.' },
  };

  async function correct(edits: object[]) {
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${ANALYSIS}/edits`,
      payload: { fundId: 'calpers', edits },
    });
    expect(res.statusCode).toBe(202);
    return settled(ANALYSIS, 'diagnosis');
  }

  it('records the edit as something the analyst did', async () => {
    const analysis = await correct([EDIT]);

    const said = analysis.messages.find(
      (m: { corrections?: unknown[] }) => m.corrections !== undefined,
    );
    expect(said.author).toBe('analyst');
    expect(said.text).toBe('Corrected 1 value.');
    expect(said.corrections).toEqual([
      { fieldKey: 'total_investments', from: '462090073000', to: '462090073' },
    ]);
  });

  /** The edit has to be above the reasoning, not after it. */
  it('puts what changed before the explanation of why', async () => {
    const analysis = await correct([EDIT]);

    const edit = analysis.messages.findIndex(
      (m: { corrections?: unknown[] }) => m.corrections !== undefined,
    );
    const why = analysis.messages.findIndex((m: { author: string }, i: number) => i > edit && m.author === 'agent');
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(why).toBeGreaterThan(edit);
  });

  it('keeps every field in the batch, in one message', async () => {
    const analysis = await correct([
      EDIT,
      { ...EDIT, id: 'e2', fieldKey: 'net_position', from: '', to: '444460764000' },
    ]);

    const withCorrections = analysis.messages.filter(
      (m: { corrections?: unknown[] }) => m.corrections !== undefined,
    );
    expect(withCorrections).toHaveLength(1);
    expect(withCorrections[0].text).toBe('Corrected 2 values.');
    expect(withCorrections[0].corrections.map((c: { fieldKey: string }) => c.fieldKey)).toEqual([
      'total_investments',
      'net_position',
    ]);
  });

  /** It survives a refresh, like everything else that was said. */
  it('is still there when the analysis is read back', async () => {
    await correct([EDIT]);

    const reread = (await app.inject({ method: 'GET', url: `/analyses/${ANALYSIS}` })).json();
    expect(
      reread.messages.find((m: { corrections?: unknown[] }) => m.corrections !== undefined)
        .corrections,
    ).toHaveLength(1);
  });

  /** A message that is not a correction should not carry an empty list. */
  it('does not attach corrections to messages that have none', async () => {
    await upload([pdf('acfr.pdf')]);

    const analysis = (await app.inject({ method: 'GET', url: `/analyses/${ANALYSIS}` })).json();
    for (const message of analysis.messages) {
      expect(message.corrections).toBeUndefined();
    }
  });
});

/**
 * Documents for the wrong fund.
 *
 * The expensive version of this is not the wrong numbers — it is that a
 * correction made against another issuer's document teaches a lesson about this
 * one. That rule then applies to every future document from a fund it was never
 * about.
 */
describe('checking the document is for this fund', () => {
  function replyWith(document: object, fields: object = EXTRACTION.fields) {
    return {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({ document, summary: 'A summary.', fields }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  }

  it('asks the model to check before it asks for any figures', async () => {
    await upload([pdf('acfr.pdf')]);

    const { messages, output_config } = lastCall();
    const prompt = messages[0].content.at(-1).text;
    expect(prompt).toContain('Before anything else, check what you have been given');
    expect(prompt).toContain('CalPERS');

    // Required, so it cannot be skipped, and it names all three answers.
    const schema = output_config.format.schema;
    expect(schema.required).toContain('document');
    expect(schema.properties.document.properties.verdict.enum).toEqual([
      'matches',
      'mismatch',
      'cannot_tell',
    ]);
  });

  it('reads nothing out of a document that is positively another fund', async () => {
    create.mockResolvedValue(
      replyWith({
        describes: 'CalSTRS, not CalPERS',
        verdict: 'mismatch',
        reasoning: 'The first page is headed California State Teachers.',
      }),
    );

    const { analysis } = await upload([pdf('calstrs.pdf')]);

    // Nothing stored. A value from the wrong fund is worse than no value.
    expect(analysis.fields).toEqual([]);
    expect(analysis.extraction.state).toBe('failed');
    expect(analysis.extraction.error).toContain('CalSTRS');
  });

  it('says what it thinks the document is, and what to do about it', async () => {
    create.mockResolvedValue(
      replyWith({
        describes: 'CalSTRS, not CalPERS',
        verdict: 'mismatch',
        reasoning: 'The first page is headed California State Teachers.',
      }),
    );

    const { analysis } = await upload([pdf('calstrs.pdf')]);
    const said = lastAgentMessage(analysis);

    expect(said?.variant).toBe('error');
    // Names the fund it should have been, then why it thinks otherwise. The
    // full fund name appears once — repeated three times it read like a form
    // letter, which is what it looked like on screen.
    expect(said?.text).toContain('do not look like CalPERS');
    expect(said?.text).toContain('headed California State Teachers');
    // Not a dead end: the analyst can overrule us, and is told how.
    expect(said?.text).toMatch(/send them again/i);
  });

  /** The documents are still stored — the analyst may well be right. */
  it('keeps the documents it refused to read', async () => {
    create.mockResolvedValue(
      replyWith({ describes: 'CalSTRS', verdict: 'mismatch', reasoning: 'Headed CalSTRS.' }),
    );
    await upload([pdf('calstrs.pdf', 128)]);

    const { rows } = await getPool().query(
      'SELECT filename FROM document WHERE analysis_id = $1',
      [ANALYSIS],
    );
    expect(rows.map((r) => r.filename)).toEqual(['calstrs.pdf']);
  });

  /**
   * The common case, and the one a naive check gets wrong. Pages cut from the
   * middle of a report name nobody. Refusing them would tell an analyst holding
   * exactly the right document that they are not.
   */
  it('extracts normally when the pages do not name any issuer', async () => {
    create.mockResolvedValue(
      replyWith({
        describes: 'a statement of fiduciary net position, issuer not named',
        verdict: 'cannot_tell',
        reasoning: 'No letterhead or plan title on these pages.',
      }),
    );

    const { analysis } = await upload([pdf('page-42.pdf')]);

    expect(analysis.fields).toHaveLength(2);
    expect(analysis.extraction).toEqual({ state: 'idle', error: null });
  });

  it('extracts normally when the document confirms the fund', async () => {
    create.mockResolvedValue(
      replyWith({
        describes: 'CalPERS, year ended 30 June 2025',
        verdict: 'matches',
        reasoning: 'Headed California Public Employees Retirement System.',
      }),
    );

    const { analysis } = await upload([pdf('acfr.pdf')]);
    expect(analysis.fields).toHaveLength(2);
    expect(analysis.extraction.state).toBe('idle');
  });

  /**
   * The recording never claims to know. It has not read anything, so it is in no
   * position to say whose document this is — and a filename is not evidence:
   * these are called financial_detail_4471.pdf in the real world.
   */
  it('the recording says it cannot tell, whatever the file is called', async () => {
    process.env.USE_FIXTURES = 'true';

    for (const name of ['calstrs-2024.pdf', 'financial_detail_4471.pdf', 'acfr.pdf']) {
      const { analysis } = await upload([pdf(name)]);
      expect(analysis.extraction).toEqual({ state: 'idle', error: null });
      expect(analysis.fields).toHaveLength(5);
    }
  });
});
