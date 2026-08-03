import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Anthropic from '@anthropic-ai/sdk';
import { MissingApiKeyError, RefusedError, ask } from './anthropic.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, MAX_PROMPT_LENGTH } from './config.js';
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

  /**
   * Proves the Anthropic integration works, with no documents involved. Keeping
   * it separate from extraction means that when extraction misbehaves later, we
   * can tell a broken model call apart from a bad prompt.
   */
  app.post<{ Body?: { prompt?: string } }>('/llm/ping', async (request, reply) => {
    const prompt = request.body?.prompt?.trim() || 'Reply with exactly: pong';

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return reply.code(400).send({
        error: 'InvalidPrompt',
        message: `Prompt exceeds ${MAX_PROMPT_LENGTH} characters.`,
      });
    }

    try {
      return await ask(prompt);
    } catch (error) {
      // The key is missing rather than wrong. Say so plainly — this is the
      // failure a new developer hits on their first run.
      if (error instanceof MissingApiKeyError) {
        return reply.code(503).send({
          error: 'NotConfigured',
          message: 'ANTHROPIC_API_KEY is not set on the server.',
        });
      }
      if (error instanceof RefusedError) {
        return reply.code(422).send({
          error: 'ModelRefused',
          message: error.message,
          category: error.category,
        });
      }
      if (error instanceof Anthropic.AuthenticationError) {
        // Ours is the broken credential, not the caller's — hence 502, not 401.
        return reply.code(502).send({
          error: 'UpstreamAuthFailed',
          message: 'The server\'s Anthropic credentials were rejected.',
        });
      }
      if (error instanceof Anthropic.RateLimitError) {
        return reply.code(429).send({
          error: 'RateLimited',
          message: 'Anthropic rate limit reached. Try again shortly.',
        });
      }
      if (error instanceof Anthropic.APIError) {
        return reply.code(502).send({
          error: 'UpstreamError',
          message: `Anthropic returned ${error.status}.`,
        });
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

      return reply.code(200).send({ uploadId, analysisId, prompt, documents: stored });
    },
  );

  return app;
}
