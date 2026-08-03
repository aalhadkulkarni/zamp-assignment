import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  ask,
  askFixture,
  describeFailure,
  usingFixtures,
  type ModelFailure,
  type Reply,
} from './anthropic.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './config.js';
import { CustomerSystemError, listFunds } from './customer.js';
import { acknowledgementPrompt } from './prompts.js';
import {
  isValidAnalysisId,
  storeUpload,
  validateDocument,
  validatePrompt,
  type IncomingDocument,
  type Rejection,
} from './documents.js';
import { resolveTenant } from './tenant.js';

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

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            documents.push({ filename: part.filename, bytes: await part.toBuffer() });
          } else if (part.fieldname === 'prompt') {
            prompt = String(part.value);
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
      // have. The upload is a 200 either way; the model's answer is a separate
      // field that may be missing, with the reason alongside it.
      let agent: Reply | null = null;
      let agentError: ModelFailure | null = null;
      // Chosen per request rather than at startup, so a test can flip the flag
      // without rebuilding the app.
      const respond = usingFixtures() ? askFixture : ask;
      try {
        agent = await respond(acknowledgementPrompt(stored.map((d) => d.filename), prompt));
      } catch (error) {
        agentError = describeFailure(error);
        if (!agentError) throw error;
        request.log.warn({ err: error }, 'model call failed after storing documents');
      }

      return reply
        .code(200)
        .send({ uploadId, analysisId, prompt, documents: stored, agent, agentError });
    },
  );

  return app;
}
