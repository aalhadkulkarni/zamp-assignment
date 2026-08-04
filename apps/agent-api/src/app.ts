import { extname } from 'node:path';
import Fastify from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  describeFailure,
  diagnose,
  diagnoseFixture,
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
  readUploadedDocuments,
  storeUpload,
  validateDocument,
  validatePrompt,
  type EditEvent,
  type IncomingDocument,
  type Rejection,
} from './documents.js';
import {
  analysisFund,
  appendMessages,
  beginExtraction,
  beginDiagnosis,
  createAnalysis,
  decideLesson,
  getAnalysis,
  listAnalyses,
  markApproved,
  storeCorrections,
  storeLessons,
} from './analyses.js';
import { diagnosisSchema, type Diagnosis } from './diagnosis.js';
import { runExtraction } from './extractionRun.js';
import { runDiagnosis } from './diagnosisRun.js';
import { onAnalysisChanged } from './events.js';
import { diagnosisPrompt } from './prompts.js';
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
  /**
   * Passed through, not restated. The label an analyst reads is the customer's
   * own naming for their own field — inventing our own, or asking a model to
   * make one up from the key, would put a second name on screen that their
   * system has never heard of.
   */
  app.get('/field-definitions', async (_request, reply) => {
    try {
      return await listFieldDefinitions();
    } catch (error) {
      if (error instanceof CustomerSystemError) {
        return reply.code(502).send({ error: 'CustomerSystemUnavailable', message: error.message });
      }
      throw error;
    }
  });

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
   * An analysis is now the server's, not the browser's. Before this it lived in
   * React state and a refresh destroyed it — including the corrections and the
   * lessons, which are the only things here worth keeping.
   */
  app.post<{ Body: { fundId?: string } }>('/analyses', async (request, reply) => {
    const fundId = request.body?.fundId;
    if (!fundId) {
      return reply.code(400).send({ error: 'InvalidRequest', message: 'fundId is required.' });
    }

    try {
      // The name is the customer's fact, looked up rather than taken from the
      // browser, so an analysis cannot be labelled with a fund that isn't theirs.
      const fund = (await listFunds()).find((f) => f.id === fundId);
      if (!fund) {
        return reply.code(404).send({ error: 'UnknownFund', message: `No fund '${fundId}'.` });
      }
      return reply.code(201).send(await createAnalysis(resolveTenant(request), fundId, fund.name));
    } catch (error) {
      if (error instanceof CustomerSystemError) {
        return reply.code(502).send({ error: 'CustomerSystemUnavailable', message: error.message });
      }
      throw error;
    }
  });

  app.get('/analyses', async (request) => listAnalyses(resolveTenant(request)));

  app.get<{ Params: { analysisId: string } }>('/analyses/:analysisId', async (request, reply) => {
    const analysis = await getAnalysis(resolveTenant(request), request.params.analysisId);
    if (!analysis) {
      return reply.code(404).send({ error: 'UnknownAnalysis', message: 'No such analysis.' });
    }
    return analysis;
  });

  /**
   * Tells a browser when an analysis has changed, so it can re-read it.
   *
   * Server-sent events rather than WebSockets: everything here goes one way,
   * server to client, and EventSource brings its own reconnection. A socket
   * would add an upgrade handshake, heartbeats and a reconnect loop of our own
   * writing to buy a direction we never send in.
   *
   * The event carries no payload beyond "something changed". The client already
   * has a way to fetch an analysis, and one description of an analysis that both
   * sides agree on beats two that can drift apart.
   */
  app.get<{ Params: { analysisId: string } }>(
    '/analyses/:analysisId/events',
    async (request, reply) => {
      const analysisId = request.params.analysisId;
      const analysis = await getAnalysis(resolveTenant(request), analysisId);
      if (!analysis) {
        return reply.code(404).send({ error: 'UnknownAnalysis', message: 'No such analysis.' });
      }

      // Writing to reply.raw bypasses the Fastify reply, and with it every
      // header a plugin has staged there — including the CORS headers, without
      // which a browser opens this stream and then silently discards it. Node's
      // tests never caught it: same-origin fetch does not need them.
      reply.raw.writeHead(200, {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Nginx and friends buffer responses by default, which for a stream
        // means holding every event until it has enough of them to be worth
        // sending. Render's proxy is one of them.
        'X-Accel-Buffering': 'no',
      });

      const send = (event: string, data: string) => {
        // A dead socket is the normal end of an SSE response, not an error.
        if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
      };

      // Immediately, so the browser knows the stream is live rather than
      // guessing from the absence of anything.
      send('open', JSON.stringify({ analysisId }));

      const unsubscribe = onAnalysisChanged(analysisId, () =>
        send('changed', JSON.stringify({ analysisId })),
      );

      // A comment line is valid SSE that no handler fires for. Proxies close
      // connections they think are idle, and this is what stops them.
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
      }, 25_000);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on('close', close);
      reply.raw.on('close', close);

      // Fastify would otherwise send its own response over the top of the
      // stream we are writing by hand.
      return reply;
    },
  );

  /**
   * Nothing becomes a rule without this. Recorded against the one lesson it
   * refers to, so accepting a proposal says nothing about the others alongside
   * it — the analyst is ratifying each diagnosis on its own terms.
   */
  app.post<{
    Params: { analysisId: string; lessonId: string };
    Body: { decision?: 'accepted' | 'rejected'; comment?: string };
  }>('/analyses/:analysisId/lessons/:lessonId', async (request, reply) => {
    const { decision, comment } = request.body ?? {};
    if (decision !== 'accepted' && decision !== 'rejected') {
      return reply
        .code(400)
        .send({ error: 'InvalidRequest', message: "decision must be 'accepted' or 'rejected'." });
    }

    const lesson = await decideLesson(
      resolveTenant(request),
      request.params.lessonId,
      decision,
      comment?.trim() || null,
    );
    if (!lesson) {
      return reply.code(404).send({ error: 'UnknownLesson', message: 'No such lesson.' });
    }
    return lesson;
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

      if (result.ok) {
        // Their database owns these values now, so ours records that and stops
        // offering to change them.
        await markApproved(request.params.analysisId, fiscalYearEnd);
        await appendMessages(request.params.analysisId, [
          {
            author: 'agent',
            text:
              `Written to the customer's system for the period ending ${fiscalYearEnd}. ` +
              'This analysis is now read-only.',
          },
        ]);
        return reply.code(201).send(result.report);
      }

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

    const tenantId = resolveTenant(request);

    // A lesson is stored against a fund, and that fund decides every future
    // document it reaches. The row is the authority on which one. See
    // analysisFund.
    const owner = await analysisFund(tenantId, analysisId);
    if (!owner) {
      return reply.code(404).send({ error: 'UnknownAnalysis', message: 'No such analysis.' });
    }
    if (owner.fundId !== fundId) {
      return reply.code(409).send({
        error: 'FundMismatch',
        message: `This analysis is for ${owner.fundName}. A fund cannot be changed after it is chosen.`,
      });
    }

    // One diagnosis at a time, for the same reason as extraction: two batches
    // being explained at once would race to append to the same conversation.
    if (!(await beginDiagnosis(analysisId))) {
      return reply.code(409).send({
        error: 'DiagnosisInProgress',
        message: 'I am still working out the last set of corrections.',
      });
    }

    // Stored before anything slow happens. They are the raw material, and a
    // failure to explain them must not lose them.
    const batchId = crypto.randomUUID();
    await storeCorrections(analysisId, batchId, edits);

    // What the analyst did belongs in the conversation, the same way their
    // uploaded documents do. Without this the corrections were only ever drawn
    // from browser state before submitting, so the moment they were sent they
    // disappeared — leaving the agent's explanation with nothing above it
    // saying what had been changed.
    await appendMessages(analysisId, [
      {
        author: 'analyst',
        text: `Corrected ${edits.length} value${edits.length === 1 ? '' : 's'}.`,
        corrections: edits.map((edit) => ({
          fieldKey: edit.fieldKey,
          from: edit.from,
          to: edit.to,
        })),
      },
    ]);

    // Deliberately not awaited. Working out why a value changed is a model call,
    // and the analyst has already been told their write succeeded — there is
    // nothing left for this request to report. The proposed lessons arrive on
    // the event stream. runDiagnosis never throws.
    void runDiagnosis({
      analysisId,
      tenantId,
      fundId: owner.fundId,
      fundName: owner.fundName,
      batchId,
      edits,
      log: request.log,
    });

    // 202: the corrections are recorded and are being looked at.
    return reply.code(202).send({ batchId, received: edits.length });
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

      // The row decides, not the caller. See analysisFund.
      const owner = await analysisFund(resolveTenant(request), analysisId);
      if (!owner) {
        return reply.code(404).send({ error: 'UnknownAnalysis', message: 'No such analysis.' });
      }
      if (owner.fundId !== fundId) {
        return reply.code(409).send({
          error: 'FundMismatch',
          message: `This analysis is for ${owner.fundName}. A fund cannot be changed after it is chosen.`,
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

      // One extraction at a time. Claimed before anything is stored so that two
      // uploads arriving together cannot both go on to rewrite the same fields.
      if (!(await beginExtraction(analysisId))) {
        return reply.code(409).send({
          error: 'ExtractionInProgress',
          message: 'I am still reading the last set of documents. Give me a moment.',
        });
      }

      const { uploadId, stored } = await storeUpload(analysisId, documents, prompt);

      // The analyst's own message goes in now, not when the agent answers. It is
      // a thing that has already happened, and holding it back until the model
      // replies is what made the composer sit on "Sending…" with nothing on
      // screen to show for it.
      await appendMessages(analysisId, [
        {
          author: 'analyst',
          text: prompt,
          attachments: stored.map((d) => ({ name: d.filename, size: d.size })),
        },
      ]);

      // Deliberately not awaited. Everything past this point takes as long as a
      // model call, and the request is answered now — the browser hears about
      // the result over its event stream. runExtraction never throws; every
      // outcome is recorded on the analysis and announced.
      void runExtraction({
        analysisId,
        tenantId: resolveTenant(request),
        fundId: owner.fundId,
        fundName: owner.fundName,
        prompt,
        documents,
        log: request.log,
      });

      // 202: accepted, not completed. The documents are stored and the work is
      // under way, which is a different promise from "here is your answer".
      return reply
        .code(202)
        .send({ uploadId, analysisId, fundId: owner.fundId, prompt, documents: stored });
    },
  );

  return app;
}
