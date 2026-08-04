import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  appendMessages,
  applicableLessons,
  finishExtraction,
  previousCorrections,
  replaceFields,
} from './analyses.js';
import { describeFailure, extract, extractFixture, usingFixtures } from './anthropic.js';
import { CustomerSystemError, listFieldDefinitions } from './customer.js';
import { analysisChanged } from './events.js';
import { extractionSchema, toReviewFields } from './extraction.js';
import { describePlan, planLessons } from './lessons.js';
import { extractionPrompt } from './prompts.js';

/**
 * Reading the documents, after the request that uploaded them has already been
 * answered.
 *
 * This used to happen inside the upload handler, which meant the browser held a
 * request open for the length of a model call — thirty to sixty seconds of a
 * send button saying "Sending…" for work the analyst had no way to watch. The
 * upload now returns as soon as the documents are safely stored, and this runs
 * on its own, ending in a notification the browser is listening for.
 *
 * Nothing here throws. A caller that is no longer waiting cannot handle an
 * error, so every outcome — including a failure — is recorded on the analysis
 * and announced the same way a success is. An extraction that fails silently
 * would leave a spinner turning forever.
 */
export type ExtractionInput = {
  analysisId: string;
  tenantId: string;
  fundId: string;
  fundName: string;
  prompt: string;
  documents: { filename: string; bytes: Buffer }[];
  log: FastifyBaseLogger;
};

export async function runExtraction(input: ExtractionInput): Promise<void> {
  const { analysisId, tenantId, fundId, fundName, prompt, documents, log } = input;

  try {
    // The field list comes from the customer, not from us and not from the
    // browser. It is their contract, and a client that could choose it could
    // choose what ends up in their database.
    const [definitions, ratified, history] = await Promise.all([
      listFieldDefinitions(),
      // Everything an analyst has confirmed that applies to this fund. This is
      // the query the database exists for, and where the loop closes: a
      // correction made on one document changes how the next one is read.
      applicableLessons(tenantId, fundId),
      // Raw evidence alongside the ratified rules. See previousCorrections for
      // why the two are fetched and rendered separately.
      previousCorrections(tenantId, fundId, analysisId),
    ]);

    // Each type goes somewhere different — the schema, the prompt, or the
    // arithmetic below. See lessons.ts for why that separation is the point.
    const plan = planLessons(ratified);

    const run = usingFixtures() ? extractFixture : extract;
    const reply = await run(
      extractionPrompt(fundName, definitions, prompt, plan.navigation, history),
      documents.map((doc) => ({
        filename: doc.filename,
        extension: extname(doc.filename).toLowerCase(),
        bytes: doc.bytes,
      })),
      extractionSchema(definitions, plan.guidance) as unknown as Record<string, unknown>,
    );

    // A document that is positively somebody else's is not extracted from at
    // all. Storing its figures would write another fund's numbers into this
    // fund's record, and — worse — any correction the analyst then made would
    // teach a lesson about this fund from a document that was never about it.
    // That is the longest-tailed mistake this system can make.
    //
    // Only a positive mismatch stops anything. 'cannot_tell' is the common case
    // for pages cut from the middle of a report, and is treated as a match.
    const check = reply.extraction.document;
    if (check?.verdict === 'mismatch') {
      log.warn({ analysisId, describes: check.describes }, 'documents are for another fund');
      // The fund's full name is long, and repeating it three times in one
      // message reads like a form letter. Said once, up front, where it matters.
      await appendMessages(analysisId, [
        {
          author: 'agent',
          text:
            `These pages do not look like ${fundName}. ${check.reasoning} ` +
            `I have not read any values out of them. If I have that wrong, send them again ` +
            `and say so in the message — otherwise upload the right documents.`,
          variant: 'error' as const,
          fixture: reply.fixture,
        },
      ]);
      await finishExtraction(analysisId, `These pages appear to be ${check.describes}.`);
      return;
    }

    // The multiplication happens here, not in the model, and a ratified units
    // lesson is enforced here too. See applyUnits.
    const fields = toReviewFields(reply.extraction, plan.expectedMultiplier);

    await appendMessages(analysisId, [
      {
        author: 'agent',
        // What was applied goes ahead of what was found. An analyst who ratified
        // a rule needs to see it act, or a value that is now right looks like
        // luck.
        text: [describePlan(plan), reply.extraction.summary].filter(Boolean).join('\n\n'),
        fixture: reply.fixture,
      },
    ]);
    await replaceFields(analysisId, fields);
    await finishExtraction(analysisId, null);
  } catch (error) {
    const failure =
      error instanceof CustomerSystemError
        ? { code: 'CustomerSystemUnavailable', message: error.message }
        : describeFailure(error);

    // An unrecognised error is still an outcome the analyst has to be told
    // about. Rethrowing would only reach an unhandled rejection handler.
    const message = failure?.message ?? 'Something went wrong while reading your documents.';
    log.warn({ err: error, analysisId }, 'extraction failed after storing documents');

    await appendMessages(analysisId, [
      {
        author: 'agent',
        text: `Your documents are stored, but I could not read them. ${message}`.trim(),
        variant: 'error' as const,
      },
    ]);
    await finishExtraction(analysisId, message);
  } finally {
    // Always, and last. This is what stops the browser waiting, so it has to
    // survive every path above it.
    await analysisChanged(analysisId).catch((error) =>
      log.error({ err: error, analysisId }, 'could not announce the finished extraction'),
    );
  }
}
