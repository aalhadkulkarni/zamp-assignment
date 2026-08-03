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
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  create.mockResolvedValue({
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Received your documents. Extraction is next.' }],
    usage: { input_tokens: 120, output_tokens: 14 },
  });
});

afterEach(async () => {
  await rm(join(dataRoot, TENANT), { recursive: true, force: true });
});

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
  { prompt, analysisId = ANALYSIS }: { prompt?: string; analysisId?: string } = {},
) {
  const form = new FormData();
  if (prompt !== undefined) form.set('prompt', prompt);
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

    // And the model is told the analyst's name, not ours.
    const [{ messages }] = create.mock.calls[0];
    expect(messages[0].content).toContain('AllTeams - GW2 (1).pdf');
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

  it('returns the model reply alongside the stored documents', async () => {
    const { status, body } = await upload([pdf('acfr.pdf')]);

    expect(status).toBe(200);
    expect(body.agent).toEqual({
      model: 'claude-opus-5',
      text: 'Received your documents. Extraction is next.',
      usage: { inputTokens: 120, outputTokens: 14 },
    });
    expect(body.agentError).toBeNull();
  });

  it('tells the model what was uploaded, and quotes the analyst note', async () => {
    await upload([pdf('acfr.pdf'), pdf('notes.md')], {
      prompt: 'Figures are in thousands.',
    });

    const [{ messages }] = create.mock.calls[0];
    expect(messages[0].content).toContain('acfr.pdf');
    expect(messages[0].content).toContain('notes.md');
    expect(messages[0].content).toContain('Figures are in thousands.');
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
