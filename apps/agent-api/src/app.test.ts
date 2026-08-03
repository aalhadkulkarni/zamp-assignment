import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './config.js';
import { uploadDir } from './documents.js';

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
  listFunds: vi.fn(async () => [{ id: 'calpers', name: 'CalPERS — California Public Employees’ Retirement System' }]),
  createReport: (...args: unknown[]) => createReport(...args),
}));

/**
 * These run against a listening server rather than app.inject, because the thing
 * under test is multipart parsing. Hand-building a multipart body to feed inject
 * would mean testing our own encoder as much as the endpoint.
 */
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let dataRoot: string;

const TENANT = 'demo-tenant';
const ANALYSIS = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'agent-api-test-'));
  process.env.DATA_DIR = dataRoot;

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
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
  create.mockResolvedValue({
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(EXTRACTION) }],
    usage: { input_tokens: 24180, output_tokens: 742 },
  });
});

afterEach(async () => {
  await rm(join(dataRoot, TENANT), { recursive: true, force: true });
});

/** Printed in thousands, as the document prints it, so units are exercised. */
const EXTRACTION = {
  summary: 'I found the investments total. Net position was not on these pages.',
  fields: [
    {
      key: 'total_investments',
      valueAsPrinted: 462_090_073,
      unitsMultiplier: 1000,
      confidence: 'high',
      sourcePage: 1,
      sourceText: 'Total Investments $462,090,073',
      reasoning: 'Investments at Fair Value, PERF A column.',
    },
    {
      key: 'net_position',
      valueAsPrinted: null,
      unitsMultiplier: 1000,
      confidence: 'low',
      sourcePage: null,
      sourceText: '',
      reasoning: 'Not present on the supplied pages.',
    },
  ],
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
  return { status: response.status, body: await response.json() };
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

    expect(status).toBe(200);
    expect(body.analysisId).toBe(ANALYSIS);
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.documents).toEqual([
      { id: expect.any(String), filename: 'acfr.pdf', storedAs: 'acfr.pdf', size: 128 },
      { id: expect.any(String), filename: 'notes.md', storedAs: 'notes.md', size: 32 },
    ]);
  });

  /**
   * Sanitising decides where the bytes land, not what the analyst may call their
   * file. Reporting the sanitised name back made it look like we had renamed
   * their document.
   */
  it('reports the name the analyst chose, and stores under a safe one', async () => {
    const { body } = await upload([
      new File([new Uint8Array(64)], 'AllTeams - GW2 (1).pdf', { type: 'application/pdf' }),
    ]);

    expect(body.documents[0].filename).toBe('AllTeams - GW2 (1).pdf');
    expect(body.documents[0].storedAs).toBe('AllTeams - GW2 _1_.pdf');

    const written = await readdir(uploadDir(TENANT, ANALYSIS));
    expect(written.some((f) => f.endsWith('AllTeams - GW2 _1_.pdf'))).toBe(true);

    // The document is titled with the analyst's name, not our sanitised one.
    const [{ messages }] = create.mock.calls[0];
    const attached = messages[0].content.find((b: { type: string }) => b.type === 'document');
    expect(attached.title).toBe('AllTeams - GW2 (1).pdf');
  });

  it('writes the bytes to disk under the tenant and analysis', async () => {
    const { body } = await upload([pdf('acfr.pdf', 128)]);

    const dir = uploadDir(TENANT, ANALYSIS);
    const written = await readdir(dir);
    const documentFile = written.find((f) => f.endsWith('acfr.pdf'));

    expect(documentFile).toBeDefined();
    expect((await readFile(join(dir, documentFile!))).length).toBe(128);
    expect(written).toContain(`upload-${body.uploadId}.json`);
  });

  it('records the prompt in the manifest alongside the documents', async () => {
    const { body } = await upload([pdf('acfr.pdf')], {
      prompt: 'Figures in the net position table are in thousands.',
    });

    const manifest = JSON.parse(
      await readFile(join(uploadDir(TENANT, ANALYSIS), `upload-${body.uploadId}.json`), 'utf8'),
    );
    expect(manifest.prompt).toBe('Figures in the net position table are in thousands.');
    expect(manifest.tenantId).toBe(TENANT);
    expect(manifest.documents).toHaveLength(1);
  });

  it('accepts an upload with no prompt', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')]);
    expect(status).toBe(200);
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

    // Nothing was written, including the document that was fine on its own.
    await expect(readdir(uploadDir(TENANT, ANALYSIS))).rejects.toThrow();
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

  it('returns the summary and the extracted rows alongside the documents', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')]);

    expect(status).toBe(200);
    expect(body.agentError).toBeNull();
    expect(body.agent).toMatchObject({
      model: 'claude-opus-5',
      summary: expect.stringContaining('investments total'),
      usage: { inputTokens: 24180, outputTokens: 742 },
      fixture: false,
    });
    expect(body.agent.fields).toHaveLength(2);
  });

  /**
   * The model reports the printed figure and the multiplier; the multiplication
   * is ours. This is the assertion that keeps it that way.
   */
  it('applies the document units rather than asking the model to', async () => {
    const { body } = await upload([pdf('acfr.pdf')]);

    const investments = body.agent.fields.find(
      (f: { key: string }) => f.key === 'total_investments',
    );
    expect(investments.valueAsPrinted).toBe(462_090_073);
    expect(investments.unitsMultiplier).toBe(1000);
    expect(investments.value).toBe(462_090_073_000);
  });

  it('leaves a value the model could not find as null, not zero', async () => {
    const { body } = await upload([pdf('acfr.pdf')]);

    const missing = body.agent.fields.find((f: { key: string }) => f.key === 'net_position');
    expect(missing.value).toBeNull();
    expect(missing.confidence).toBe('low');
  });

  it('asks the model only for fields the customer actually publishes', async () => {
    await upload([pdf('acfr.pdf')]);

    const [{ output_config }] = create.mock.calls[0];
    const keys = output_config.format.schema.properties.fields.items.properties.key.enum;
    // An enum here means the model cannot invent a field for customer-system to
    // reject three steps later.
    expect(keys).toEqual(['total_investments', 'net_position']);
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

    it('still reports the upload as succeeded, with the reason attached', async () => {
      const { status, body } = await failWith(await sdkError('RateLimitError', 429));

      expect(status).toBe(200);
      expect(body.documents).toHaveLength(1);
      expect(body.agent).toBeNull();
      expect(body.agentError).toEqual({
        code: 'RateLimited',
        message: expect.stringMatching(/rate limiting/i),
      });
    });

    it('still writes the documents to disk', async () => {
      await failWith(await sdkError('APIError', 529));

      const written = await readdir(uploadDir(TENANT, ANALYSIS));
      expect(written.some((f) => f.endsWith('acfr.pdf'))).toBe(true);
    });

    it('names a missing API key rather than blaming the upload', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { status, body } = await upload([pdf('acfr.pdf')]);

      expect(status).toBe(200);
      expect(body.agentError.code).toBe('NotConfigured');
      expect(body.documents).toHaveLength(1);
    });

    it('reports a refusal as its own outcome', async () => {
      create.mockResolvedValue({
        model: 'claude-opus-5',
        stop_reason: 'refusal',
        content: [],
        stop_details: { category: 'cyber' },
        usage: { input_tokens: 5, output_tokens: 0 },
      });

      const { body } = await upload([pdf('acfr.pdf')]);
      expect(body.agentError.code).toBe('ModelRefused');
    });
  });

  /**
   * The point of fixture mode is that development and tests cost nothing, so
   * the assertion that matters is that no request is made at all.
   */
  describe('fixture mode', () => {
    it('answers from the recording without calling the API', async () => {
      process.env.USE_FIXTURES = 'true';
      const { status, body } = await upload([pdf('acfr.pdf')]);

      expect(status).toBe(200);
      expect(body.agent.fixture).toBe(true);
      expect(body.agent.summary).toMatch(/four of the five values/i);
      expect(body.agent.fields).toHaveLength(5);
      expect(create).not.toHaveBeenCalled();
    });

    it('works with no API key at all', async () => {
      process.env.USE_FIXTURES = 'true';
      delete process.env.ANTHROPIC_API_KEY;

      const { status, body } = await upload([pdf('acfr.pdf')]);
      expect(status).toBe(200);
      expect(body.agentError).toBeNull();
      expect(body.agent.fixture).toBe(true);
    });

    it('still stores the documents', async () => {
      process.env.USE_FIXTURES = 'true';
      await upload([pdf('acfr.pdf', 128)]);

      const written = await readdir(uploadDir(TENANT, ANALYSIS));
      expect(written.some((f) => f.endsWith('acfr.pdf'))).toBe(true);
    });

    it('is off unless explicitly switched on', async () => {
      const { body } = await upload([pdf('acfr.pdf')]);

      expect(body.agent.fixture).toBe(false);
      expect(create).toHaveBeenCalledOnce();
    });

    it('is not switched on by a value that merely looks truthy', async () => {
      process.env.USE_FIXTURES = '1';
      const { body } = await upload([pdf('acfr.pdf')]);

      expect(body.agent.fixture).toBe(false);
      expect(create).toHaveBeenCalledOnce();
    });
  });

  it('stores a document whose name would otherwise escape the upload folder', async () => {
    const { status } = await upload([
      new File([new Uint8Array(64)], '../../../etc/passwd.pdf', { type: 'application/pdf' }),
    ]);

    expect(status).toBe(200);
    const written = await readdir(uploadDir(TENANT, ANALYSIS));
    expect(written.some((f) => f.endsWith('passwd.pdf'))).toBe(true);
    expect(written.every((f) => !f.includes('/'))).toBe(true);
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

  async function submit(body: object, analysisId = ANALYSIS) {
    const res = await app.inject({
      method: 'POST',
      url: `/analyses/${analysisId}/edits`,
      payload: body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  const DIAGNOSIS_REPLY = {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          summary: 'You scaled a figure that was already in whole dollars.',
          lessons: [
            {
              type: 'units',
              scope: 'fund',
              fieldKeys: ['total_investments'],
              explanation: 'The heading said thousands but this section did not follow it.',
              rule: 'Check whether the investments section restates its units.',
              confidence: 'medium',
            },
          ],
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

    expect(status).toBe(201);
    expect(body).toMatchObject({ batchId: expect.any(String), received: 2 });
  });

  describe('the diagnosis', () => {
    it('asks the model why, and returns what it proposed', async () => {
      const { body } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(body.diagnosis.summary).toMatch(/already in whole dollars/);
      expect(body.diagnosis.lessons).toHaveLength(1);
      expect(body.diagnosis.lessons[0]).toMatchObject({ type: 'units', scope: 'fund' });
      expect(body.error).toBeNull();
    });

    /** An accept has to name exactly one lesson, and a model inventing ids is a
     *  way to get collisions and dangling references for no benefit. */
    it('assigns the lesson ids itself', async () => {
      const { body } = await submit({ fundId: 'calpers', edits: [EDIT] });
      expect(body.diagnosis.lessons[0].id).toMatch(/^[0-9a-f-]{36}$/);
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
      const { status, body } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(status).toBe(201);
      expect(body.diagnosis.lessons).toHaveLength(1);
      const [{ messages }] = create.mock.calls[0];
      expect(messages[0].content.filter((b: { type: string }) => b.type === 'document')).toHaveLength(0);
    });

    it('constrains the lessons to fields that were actually corrected', async () => {
      await submit({ fundId: 'calpers', edits: [EDIT] });

      const [{ output_config }] = create.mock.calls[0];
      const keys =
        output_config.format.schema.properties.lessons.items.properties.fieldKeys.items.enum;
      expect(keys).toEqual(['total_investments']);
    });

    /** The corrections are the raw material. Losing them because the
     *  explanation failed would be the expensive half of the mistake. */
    it('keeps the corrections when the diagnosis fails', async () => {
      create.mockRejectedValue(await sdkError('RateLimitError', 429));

      const { status, body } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(status).toBe(201);
      expect(body.batchId).toEqual(expect.any(String));
      expect(body.diagnosis).toBeNull();
      expect(body.error.code).toBe('RateLimited');

      const stored = JSON.parse(
        await readFile(join(uploadDir(TENANT, ANALYSIS), `edits-${body.batchId}.json`), 'utf8'),
      );
      expect(stored.edits).toHaveLength(1);
    });

    it('answers from the recording in fixture mode', async () => {
      process.env.USE_FIXTURES = 'true';
      const { body } = await submit({ fundId: 'calpers', edits: [EDIT] });

      expect(body.diagnosis.lessons.length).toBeGreaterThan(1);
      expect(create).not.toHaveBeenCalled();
    });
  });

  /**
   * One file for the whole batch, not one per field. Corrections made together
   * are the evidence that they share a cause — five values changed by the same
   * factor is one mistake about units, and splitting them loses that.
   */
  it('writes the corrections as a single batch, with their provenance', async () => {
    const { body } = await submit({ fundId: 'calpers', edits: [EDIT] });

    const stored = JSON.parse(
      await readFile(join(uploadDir(TENANT, ANALYSIS), `edits-${body.batchId}.json`), 'utf8'),
    );
    expect(stored.fundId).toBe('calpers');
    expect(stored.edits).toHaveLength(1);
    expect(stored.edits[0].context.sourceText).toBe('Total Investments $462,090,073');
    expect(stored.submittedAt).toEqual(expect.any(String));
  });

  /** The analyst agreeing with us is a normal outcome, not a failure. */
  it('accepts an empty batch without writing anything', async () => {
    const { status, body } = await submit({ fundId: 'calpers', edits: [] });

    expect(status).toBe(200);
    expect(body).toMatchObject({ batchId: null, received: 0, diagnosis: null });
    await expect(readdir(uploadDir(TENANT, ANALYSIS))).rejects.toThrow();
  });

  it('refuses an analysis id that could steer a filesystem path', async () => {
    const { status } = await submit({ fundId: 'calpers', edits: [EDIT] }, 'not-a-uuid');
    expect(status).toBe(400);
  });

  it('refuses a batch that does not say which fund it belongs to', async () => {
    const { status, body } = await submit({ edits: [EDIT] });
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidRequest');
  });
});
