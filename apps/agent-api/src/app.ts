import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from './config.js';
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
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
  });

  app.get('/health', async () => ({ ok: true, service: 'agent-api' }));

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

      return reply.code(200).send({ uploadId, analysisId, prompt, documents: stored });
    },
  );

  return app;
}
