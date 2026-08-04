import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { appendMessages, finishDiagnosis, storeLessons } from './analyses.js';
import { describeFailure, diagnose, diagnoseFixture, usingFixtures } from './anthropic.js';
import { CustomerSystemError, listFieldDefinitions } from './customer.js';
import { diagnosisSchema, type Diagnosis } from './diagnosis.js';
import { analysisChanged } from './events.js';
import type { EditEvent } from './documents.js';
import { readUploadedDocuments } from './documents.js';
import { diagnosisPrompt } from './prompts.js';

/**
 * Working out why a batch of corrections happened, after the request that
 * submitted them has been answered.
 *
 * The same reasoning as runExtraction, for the same reason: this is a model
 * call, and a model call is not something to hold a browser's request open for.
 * The corrections were already stored and the write already confirmed by the
 * time this starts, so there is nothing the analyst is waiting on except the
 * explanation itself.
 *
 * Nothing here throws. The corrections are the raw material and they are
 * already safe; a failure to explain them is its own outcome, recorded and
 * announced so the browser stops waiting.
 */
export type DiagnosisInput = {
  analysisId: string;
  tenantId: string;
  fundId: string;
  fundName: string;
  batchId: string;
  edits: EditEvent[];
  log: FastifyBaseLogger;
};

export async function runDiagnosis(input: DiagnosisInput): Promise<void> {
  const { analysisId, tenantId, fundId, fundName, batchId, edits, log } = input;

  try {
    const definitions = await listFieldDefinitions();
    const fieldKeys = [...new Set(edits.map((e) => e.fieldKey))];

    // The pages the analyst was looking at. Without them the model can only
    // diagnose units errors and slips — the other three lesson types are about
    // what else was on the page.
    const pages = await readUploadedDocuments(analysisId);

    const run = usingFixtures() ? diagnoseFixture : diagnose;
    const reply = await run(
      diagnosisPrompt(fundName, definitions, edits),
      pages.map((doc) => ({
        filename: doc.filename,
        extension: extname(doc.filename).toLowerCase(),
        bytes: doc.bytes,
      })),
      diagnosisSchema(fieldKeys) as unknown as Record<string, unknown>,
    );

    if (!isUsable(reply.diagnosis)) {
      // The corrections are stored, so this is a degraded outcome rather than a
      // failure — saying nothing at all would be worse than saying we could not
      // work it out.
      log.warn({ analysisId }, 'the diagnosis came back in a shape we cannot use');
      await appendMessages(analysisId, [
        {
          author: 'agent',
          text: 'Your corrections are recorded, but I could not work out what caused them.',
          variant: 'error' as const,
        },
      ]);
      await finishDiagnosis(analysisId, null);
      return;
    }

    await appendMessages(analysisId, [
      { author: 'agent', text: reply.diagnosis.summary, fixture: reply.fixture },
    ]);
    await storeLessons(tenantId, analysisId, batchId, fundId, reply.diagnosis.lessons);
    await finishDiagnosis(analysisId, null);
  } catch (error) {
    const failure =
      error instanceof CustomerSystemError
        ? { code: 'CustomerSystemUnavailable', message: error.message }
        : describeFailure(error);
    const message = failure?.message ?? 'Something went wrong while explaining those corrections.';
    log.warn({ err: error, analysisId }, 'diagnosis failed after storing the corrections');

    await appendMessages(analysisId, [
      {
        author: 'agent',
        text: `Your corrections are recorded, but I could not explain them. ${message}`.trim(),
        variant: 'error' as const,
      },
    ]);
    await finishDiagnosis(analysisId, message);
  } finally {
    // Always, and last. This is what stops the browser waiting.
    await analysisChanged(analysisId).catch((error) =>
      log.error({ err: error, analysisId }, 'could not announce the finished diagnosis'),
    );
  }
}

/** A model can return valid JSON that is still not an answer. */
function isUsable(diagnosis: Diagnosis | undefined): diagnosis is Diagnosis {
  return (
    typeof diagnosis?.summary === 'string' &&
    diagnosis.summary.trim() !== '' &&
    Array.isArray(diagnosis.lessons)
  );
}
