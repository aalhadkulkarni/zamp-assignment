import Fastify from 'fastify';
import cors from '@fastify/cors';
import { openDatabase } from './db.js';
import { FIELD_DEFINITIONS, FIELD_KEYS } from './fields.js';

type ReportBody = {
  fiscalYearEnd?: unknown;
  values?: unknown;
};

/** A fiscal year end is a calendar date. Anything else is a mis-read, not a format preference. */
const FISCAL_YEAR_END = /^\d{4}-\d{2}-\d{2}$/;

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true });

  const db = openDatabase();
  app.addHook('onClose', async () => db.close());

  app.get('/health', async () => ({ ok: true, service: 'customer-system' }));

  /** The funds an analyst can be assigned. */
  app.get('/funds', async () => db.prepare('SELECT id, name FROM fund ORDER BY name').all());

  /**
   * The contract. agent-api reads this to know what to extract; it is the only
   * reason that service can stay domain-agnostic.
   */
  app.get('/field-definitions', async () => FIELD_DEFINITIONS);

  app.get<{ Params: { fundId: string } }>('/funds/:fundId/reports', async (request, reply) => {
    const fund = db.prepare('SELECT id FROM fund WHERE id = ?').get(request.params.fundId);
    if (!fund) {
      return reply.code(404).send({ error: 'UnknownFund', message: 'No such fund.' });
    }

    return db
      .prepare('SELECT * FROM report WHERE fund_id = ? ORDER BY fiscal_year_end DESC')
      .all(request.params.fundId);
  });

  app.post<{ Params: { fundId: string }; Body: ReportBody }>(
    '/funds/:fundId/reports',
    async (request, reply) => {
      const { fundId } = request.params;
      const { fiscalYearEnd, values } = request.body ?? {};

      const fund = db.prepare('SELECT id FROM fund WHERE id = ?').get(fundId);
      if (!fund) {
        return reply.code(404).send({ error: 'UnknownFund', message: `No fund '${fundId}'.` });
      }

      if (typeof fiscalYearEnd !== 'string' || !FISCAL_YEAR_END.test(fiscalYearEnd)) {
        return reply.code(400).send({
          error: 'InvalidFiscalYearEnd',
          message: 'fiscalYearEnd must be a date in YYYY-MM-DD form.',
        });
      }

      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        return reply.code(400).send({
          error: 'InvalidValues',
          message: 'values must be an object keyed by field.',
        });
      }

      // Report every problem at once. Returning them one at a time would make an
      // analyst fix, resubmit, and discover the next one.
      const problems: { field: string; reason: string }[] = [];
      const supplied = values as Record<string, unknown>;

      for (const key of Object.keys(supplied)) {
        if (!FIELD_KEYS.includes(key)) {
          problems.push({ field: key, reason: 'Not a field in this schema.' });
        }
      }

      for (const definition of FIELD_DEFINITIONS) {
        const amount = supplied[definition.key];
        if (amount === undefined || amount === null) {
          if (definition.required) {
            problems.push({ field: definition.key, reason: 'Required.' });
          }
          continue;
        }
        if (typeof amount !== 'number' || !Number.isFinite(amount)) {
          problems.push({ field: definition.key, reason: 'Must be a number.' });
        } else if (!Number.isInteger(amount)) {
          // Amounts are whole USD. A fraction usually means a units conversion
          // went wrong somewhere upstream.
          problems.push({ field: definition.key, reason: 'Must be a whole number of USD.' });
        }
      }

      if (problems.length > 0) {
        return reply.code(400).send({
          error: 'ValidationFailed',
          message: 'The report was not stored.',
          problems,
        });
      }

      const id = crypto.randomUUID();
      try {
        db.prepare(
          `INSERT INTO report (
             id, fund_id, fiscal_year_end,
             total_receivables, total_investments, total_assets,
             total_liabilities, net_position, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          fundId,
          fiscalYearEnd,
          supplied.total_receivables as number,
          supplied.total_investments as number,
          supplied.total_assets as number,
          supplied.total_liabilities as number,
          supplied.net_position as number,
          new Date().toISOString(),
        );
      } catch (error) {
        const message = (error as Error).message ?? '';

        // The database is the authority, not the checks above. These map its
        // refusals onto something the analyst can act on.
        if (message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'ReportAlreadyExists',
            message: `A report for ${fundId} ending ${fiscalYearEnd} is already on file.`,
          });
        }
        if (message.includes('CHECK constraint failed')) {
          return reply.code(400).send({
            error: 'ValidationFailed',
            message: 'The report was not stored.',
            problems: [{ field: constraintField(message), reason: 'Outside the permitted range.' }],
          });
        }
        throw error;
      }

      return reply.code(201).send({
        id,
        fundId,
        fiscalYearEnd,
        values: Object.fromEntries(FIELD_KEYS.map((k) => [k, supplied[k]])),
      });
    },
  );

  return app;
}

/** SQLite reports "CHECK constraint failed: total_assets > 0". Pull the column out. */
function constraintField(message: string): string {
  return FIELD_KEYS.find((key) => message.includes(key)) ?? 'unknown';
}
