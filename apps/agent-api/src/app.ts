import { extname } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  describeFailure,
  diagnose,
  diagnoseFixture,
  extract,
  extractFixture,
  usingFixtures,
  type ModelFailure,
} from './anthropic.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './config.js';
import {
  CustomerSystemError,
  createReport,
  listFieldDefinitions,
  listFunds,
  type FieldDefinition,
} from './customer.js';
import {
  isValidAnalysisId,
  storeEdits,
  storeUpload,
  validateDocument,
  validatePrompt,
  type EditEvent,
  type IncomingDocument,
  type Rejection,
} from './documents.js';
import { diagnosisSchema, type Diagnosis } from './diagnosis.js';
import { applyUnits, extractionSchema, type ReviewField } from './extraction.js';
import { diagnosisPrompt, extractionPrompt } from './prompts.js';
import { resolveTenant } from './tenant.js';

/**
 * Turns the text the analyst saw into what the customer's schema asks for.
 *
 * Deliberately conservative. A money field holding "see note 7" is forwarded as
 * that string rather than converted to NaN or dropped, so their API returns
 * "Must be a number" against that field and the analyst learns what is actually
 * wrong. Guessing on their behalf would hide a real disagreement about the data.
 *
 * An empty value is omitted entirely — absent and blank are different claims,
 * and their schema decides whether a missing required field is acceptable.
 */
function coerce(
  values: Record<string, string>,
  definitions: FieldDefinition[],
): Record<string, unknown> {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(values)) {
    const text = raw.trim();
    if (text === '') continue;

    const definition = byKey.get(key);
    if (definition?.type === 'money') {
      const asNumber = Number(text);
      out[key] = Number.isFinite(asNumber) ? asNumber : text;
    } else {
      // An unknown key is passed through so their "not a field in this schema"
      // rejection fires rather than us silently discarding the analyst's work.
      out[key] = text;
    }
  }

  return out;
}

/** What the analyst gets back: prose for the chat, rows for the table. */
type ExtractionResult = {
  model: string;
  summary: string;
  fields: ReviewField[];
  usage: { inputTokens: number; outputTokens: number };
  fixture: boolean;
};

export async function buildApp() {
  // Quiet under test, on everywhere else. Without this the warning logged when
  // a model call fails goes nowhere, which is how a billing error spent a while
  // looking like a malformed request.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
  });

  app.get('/health', async () => ({ ok: true, service: 'agent-api' }));

  /**
   * Passed through from the customer's system rather than held here. Which funds
   * exist is their fact, not ours, and the day they add one we should not need a
   * deploy.
   */
  app.get('/funds', async (_request, reply) => {
    try {
      return await listFunds();
    } catch (error) {
      if (error instanceof CustomerSystemError) {
        return reply.code(502).send({ error: 'CustomerSystemUnavailable', message: error.message });
      }
      throw error;
    }
  });

  /**
   * The write. Values arrive as the text the analyst saw, and are coerced here
   * against the customer's own field definitions — but only where the coercion
   * is unambiguous. Anything that does not convert is forwarded untouched so
   * that their schema is the one that refuses it, not a guess of ours.
   */
  app.post<{
    Params: { analysisId: string };
    Body: { fundId?: string; fiscalYearEnd?: string; values?: Record<string, string> };
  }>('/analyses/:analysisId/report', async (request, reply) => {
    const { fundId, fiscalYearEnd, values } = request.body ?? {};

    if (!fundId || !fiscalYearEnd || typeof values !== 'object' || values === null) {
      return reply.code(400).send({
        error: 'InvalidRequest',
        message: 'fundId, fiscalYearEnd and values are all required.',
      });
    }

    try {
      const definitions = await listFieldDefinitions();
      const result = await createReport(fundId, fiscalYearEnd, coerce(values, definitions));

      if (result.ok) return reply.code(201).send(result.report);

      request.log.info({ rejection: result }, 'customer system refused the write');
      return reply.code(result.status).send({
        error: result.error,
        message: result.message,
        problems: result.problems ?? [],
      });
    } catch (error) {
      if (error instanceof CustomerSystemError) {
        return reply.code(502).send({ error: 'CustomerSystemUnavailable', message: error.message });
      }
      throw error;
    }
  });

  /**
   * The corrections an analyst made during review, submitted as one batch.
   *
   * A batch rather than one call per field, because corrections made together
   * are usually one mistake seen from several angles. Five values all changed by
   * the same factor is a single misunderstanding about units; asked about one at
   * a time, that pattern is invisible and the diagnosis would find five
   * coincidences instead of a cause.
   *
   * Returns the model's proposed lessons. Nothing is learned from them yet —
   * that needs the analyst to confirm, which is step 11.
   */
  app.post<{
    Params: { analysisId: string };
    Body: { fundId?: string; edits?: EditEvent[] };
  }>('/analyses/:analysisId/edits', async (request, reply) => {
    const { analysisId } = request.params;
    if (!isValidAnalysisId(analysisId)) {
      return reply
        .code(400)
        .send({ error: 'InvalidAnalysisId', message: 'Analysis id must be a uuid.' });
    }

    const { fundId, edits } = request.body ?? {};
    if (!fundId || !Array.isArray(edits)) {
      return reply
        .code(400)
        .send({ error: 'InvalidRequest', message: 'fundId and edits are required.' });
    }

    // Nothing to learn from. Not an error — the analyst simply agreed with us.
    if (edits.length === 0) {
      return reply.code(200).send({ batchId: null, received: 0, diagnosis: null, error: null });
    }

    const batchId = await storeEdits(resolveTenant(request), analysisId, fundId, edits);

    // The corrections are recorded whatever happens next. A failed diagnosis
    // must not lose them — they are the raw material, and the explanation can
    // be attempted again.
    let diagnosis: Diagnosis | null = null;
    let error: ModelFailure | null = null;
    try {
      const [definitions, funds] = await Promise.all([listFieldDefinitions(), listFunds()]);
      const fundName = funds.find((f) => f.id === fundId)?.name ?? fundId;
      const fieldKeys = [...new Set(edits.map((e) => e.fieldKey))];

      const run = usingFixtures() ? diagnoseFixture : diagnose;
      const result = await run(
        diagnosisPrompt(fundName, definitions, edits),
        diagnosisSchema(fieldKeys) as unknown as Record<string, unknown>,
      );

      // Structured outputs should guarantee this, but the corrections are
      // already safely stored — degrading to "could not explain" beats a 500
      // that makes a successful write look like a failure.
      if (!Array.isArray(result.diagnosis?.lessons)) {
        throw new Error('The diagnosis did not come back in the expected shape.');
      }

      // Ids are assigned here, not asked of the model. A model inventing
      // identifiers is a way to get collisions and dangling references for no
      // benefit — and an accept has to name exactly one lesson.
      diagnosis = {
        summary: result.diagnosis.summary,
        lessons: result.diagnosis.lessons.map((lesson) => ({
          ...lesson,
          id: crypto.randomUUID(),
        })),
      };
    } catch (thrown) {
      error = describeFailure(thrown) ?? {
        code: 'DiagnosisFailed',
        message: 'Your corrections were recorded, but could not be explained.',
      };
      request.log.warn({ err: thrown }, 'diagnosis failed after storing the corrections');
    }

    return reply.code(201).send({ batchId, received: edits.length, diagnosis, error });
  });

  app.post<{ Params: { analysisId: string } }>(
    '/analyses/:analysisId/documents',
    async (request, reply) => {
      const { analysisId } = request.params;
      if (!isValidAnalysisId(analysisId)) {
        return reply.code(400).send({
          error: 'InvalidAnalysisId',
          message: 'Analysis id must be a uuid.',
        });
      }

      if (!request.isMultipart()) {
        return reply.code(415).send({
          error: 'UnsupportedMediaType',
          message: 'Send the documents as multipart/form-data.',
        });
      }

      const documents: IncomingDocument[] = [];
      let prompt = '';
      let fundId = '';
      let fundName = '';

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            documents.push({ filename: part.filename, bytes: await part.toBuffer() });
          } else if (part.fieldname === 'prompt') {
            prompt = String(part.value);
          } else if (part.fieldname === 'fundId') {
            fundId = String(part.value);
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({
            error: 'FileTooLarge',
            message: `Each document must be under ${MAX_FILE_BYTES} bytes.`,
          });
        }
        if (code === 'FST_FILES_LIMIT') {
          return reply.code(413).send({
            error: 'TooManyFiles',
            message: `At most ${MAX_FILES_PER_UPLOAD} documents per upload.`,
          });
        }
        throw error;
      }

      if (documents.length === 0) {
        return reply.code(400).send({
          error: 'NoDocuments',
          message: 'At least one document is required.',
        });
      }

      // Which fund this is for decides nothing about storage, but everything
      // about extraction — and eventually which record gets written. Checked
      // here because it costs nothing; whether the fund actually exists is the
      // customer's ruling, made when we try to write.
      if (!fundId) {
        return reply.code(400).send({
          error: 'MissingFund',
          message: 'fundId is required.',
        });
      }

      const promptError = validatePrompt(prompt);
      if (promptError) {
        return reply.code(400).send({ error: 'InvalidPrompt', message: promptError });
      }

      // All or nothing. The browser already filters, so a bad document arriving
      // here means the request did not come from our UI — storing the rest would
      // be guessing at what the caller wanted.
      const rejected: Rejection[] = [];
      for (const doc of documents) {
        const rejection = validateDocument(doc);
        if (rejection) rejected.push(rejection);
      }
      if (rejected.length > 0) {
        return reply.code(400).send({
          error: 'UnacceptableDocuments',
          message: 'No documents were stored.',
          rejected,
        });
      }

      const tenantId = resolveTenant(request);
      const { uploadId, stored } = await storeUpload(tenantId, analysisId, documents, prompt);

      // The documents are on disk by this point, so a model failure must not be
      // reported as a failed upload — the analyst would re-send files we already
      // have. The upload is a 200 either way; extraction is a separate field
      // that may be missing, with the reason alongside it.
      let agent: ExtractionResult | null = null;
      let agentError: ModelFailure | null = null;

      // Chosen per request rather than at startup, so a test can flip the flag
      // without rebuilding the app.
      const run = usingFixtures() ? extractFixture : extract;
      try {
        // The field list comes from the customer, not from us and not from the
        // browser. It is their contract, and a client that could choose it could
        // choose what ends up in their database. The fund's name is theirs too —
        // the browser sends an id, never a label we then repeat back as fact.
        const [definitions, funds] = await Promise.all([listFieldDefinitions(), listFunds()]);
        fundName = funds.find((f) => f.id === fundId)?.name ?? fundId;
        const reply_ = await run(
          extractionPrompt(fundName, definitions, prompt),
          documents.map((doc) => ({
            filename: doc.filename,
            extension: extname(doc.filename).toLowerCase(),
            bytes: doc.bytes,
          })),
          extractionSchema(definitions) as unknown as Record<string, unknown>,
        );

        agent = {
          model: reply_.model,
          summary: reply_.extraction.summary,
          // The multiplication happens here, not in the model. See applyUnits.
          fields: reply_.extraction.fields.map(applyUnits),
          usage: reply_.usage,
          fixture: reply_.fixture,
        };
      } catch (error) {
        agentError =
          error instanceof CustomerSystemError
            ? { code: 'CustomerSystemUnavailable', message: error.message }
            : describeFailure(error);
        if (!agentError) throw error;
        request.log.warn({ err: error }, 'extraction failed after storing documents');
      }

      return reply
        .code(200)
        .send({ uploadId, analysisId, fundId, prompt, documents: stored, agent, agentError });
    },
  );

  return app;
}
