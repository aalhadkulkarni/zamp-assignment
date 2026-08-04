import { getPool } from './db.js';
import type { LessonScope, LessonType } from './diagnosis.js';
import type { ReviewField } from './extraction.js';

/**
 * Everything an analysis is, as the browser needs it. Assembled from several
 * tables rather than stored as one blob, because the lesson rows have to be
 * queryable on their own — see the lesson lookup at the bottom of this file.
 */
export type StoredMessage = {
  id: string;
  author: 'agent' | 'analyst';
  text: string;
  variant?: 'error';
  fixture?: boolean;
  attachments?: { name: string; size: number }[];
};

export type StoredLesson = {
  id: string;
  type: LessonType;
  scope: LessonScope;
  fieldKeys: string[];
  explanation: string;
  rule: string;
  unitsMultiplier: number | null;
  documentLabel: string;
  confidence: 'high' | 'medium' | 'low';
  decision?: 'accepted' | 'rejected';
  comment?: string;
};

export type StoredAnalysis = {
  id: string;
  fundId: string;
  fundName: string;
  status: 'draft' | 'approved';
  fiscalYearEnd: string;
  createdAt: string;
  messages: StoredMessage[];
  fields: ReviewField[];
  lessons: StoredLesson[];
};

export type AnalysisSummary = {
  id: string;
  fundId: string;
  fundName: string;
  status: 'draft' | 'approved';
  createdAt: string;
};

export async function createAnalysis(
  tenantId: string,
  fundId: string,
  fundName: string,
): Promise<AnalysisSummary> {
  const { rows } = await getPool().query(
    `INSERT INTO analysis (id, tenant_id, fund_id, fund_name)
     VALUES (gen_random_uuid(), $1, $2, $3)
     RETURNING id, fund_id, fund_name, status, created_at`,
    [tenantId, fundId, fundName],
  );
  return toSummary(rows[0]);
}

export async function listAnalyses(tenantId: string): Promise<AnalysisSummary[]> {
  const { rows } = await getPool().query(
    `SELECT id, fund_id, fund_name, status, created_at
       FROM analysis WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(toSummary);
}

/** Null when the analysis does not exist, or belongs to another tenant. */
export async function getAnalysis(
  tenantId: string,
  analysisId: string,
): Promise<StoredAnalysis | null> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, fund_id, fund_name, status, fiscal_year_end, created_at
       FROM analysis WHERE id = $1 AND tenant_id = $2`,
    [analysisId, tenantId],
  );
  if (rows.length === 0) return null;

  const [messages, fields, lessons, correctionRows] = await Promise.all([
    pool.query(
      `SELECT id, author, body, variant, fixture, attachments
         FROM message WHERE analysis_id = $1 ORDER BY seq`,
      [analysisId],
    ),
    pool.query(
      `SELECT field_key, value, value_as_printed, units_multiplier,
              confidence, source_page, source_text, reasoning
         FROM extracted_field WHERE analysis_id = $1 ORDER BY field_key`,
      [analysisId],
    ),
    pool.query(
      `SELECT id, type, scope, field_keys, explanation, rule, units_multiplier,
              document_label, confidence, decision, comment
         FROM lesson WHERE analysis_id = $1 ORDER BY created_at`,
      [analysisId],
    ),
    // The analyst's submitted corrections, newest per field. Without these the
    // table shows what the model proposed rather than what was agreed and
    // written — which reads as "not found" for a value the customer now holds.
    pool.query(
      `SELECT DISTINCT ON (field_key) field_key, to_value
         FROM correction WHERE analysis_id = $1
        ORDER BY field_key, created_at DESC`,
      [analysisId],
    ),
  ]);

  const corrected = new Map<string, string>(
    correctionRows.rows.map((c) => [c.field_key, c.to_value]),
  );

  const row = rows[0];
  return {
    id: row.id,
    fundId: row.fund_id,
    fundName: row.fund_name,
    status: row.status,
    fiscalYearEnd: row.fiscal_year_end ?? '',
    createdAt: iso(row.created_at),
    messages: messages.rows.map((m) => ({
      id: m.id,
      author: m.author,
      text: m.body,
      ...(m.variant ? { variant: m.variant } : {}),
      ...(m.fixture ? { fixture: true } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
    })),
    // Postgres returns numeric as a string so it cannot silently lose precision
    // on the way out. These are whole dollars in the billions, so the conversion
    // has to be deliberate rather than left to the driver.
    fields: fields.rows.map((f) => {
      const correction = corrected.get(f.field_key);
      return {
        key: f.field_key,
        // What the analyst settled on, falling back to what the model read. The
        // provenance below still describes the model's reading, which is the
        // point: it is how you check the value against the page.
        value:
          correction === undefined
            ? numeric(f.value)
            : correction === ''
              ? null
              : Number(correction),
        valueAsPrinted: numeric(f.value_as_printed),
        unitsMultiplier: Number(f.units_multiplier),
        confidence: f.confidence,
        sourcePage: f.source_page,
        sourceText: f.source_text,
        reasoning: f.reasoning,
        ...(f.lesson_note ? { lessonNote: f.lesson_note as string } : {}),
      };
    }),
    lessons: lessons.rows.map(toLesson),
  };
}

/**
 * Which fund an analysis belongs to, according to the row rather than the
 * caller.
 *
 * Both the extraction and the diagnosis need this, and both used to take it from
 * the request body. That made the client the authority on a fact the server
 * already knew — and the fact happens to be the one that decides which ratified
 * lessons apply, so a wrong or forged value would read one fund's rules into
 * another fund's document. The fund is fixed when the analysis is created and
 * nothing afterwards may restate it.
 */
export async function analysisFund(
  tenantId: string,
  analysisId: string,
): Promise<{ fundId: string; fundName: string } | null> {
  const { rows } = await getPool().query(
    'SELECT fund_id, fund_name FROM analysis WHERE id = $1 AND tenant_id = $2',
    [analysisId, tenantId],
  );
  return rows.length > 0
    ? { fundId: rows[0].fund_id as string, fundName: rows[0].fund_name as string }
    : null;
}

export async function appendMessages(
  analysisId: string,
  messages: Omit<StoredMessage, 'id'>[],
): Promise<void> {
  if (messages.length === 0) return;
  const pool = getPool();

  // seq rather than a timestamp: two messages written in the same millisecond
  // are common here — an analyst message and the agent's reply — and their
  // order is the whole point of a conversation.
  const { rows } = await pool.query(
    'SELECT coalesce(max(seq), 0) AS seq FROM message WHERE analysis_id = $1',
    [analysisId],
  );
  let seq = Number(rows[0].seq);

  for (const message of messages) {
    seq += 1;
    await pool.query(
      `INSERT INTO message (id, analysis_id, seq, author, body, variant, fixture, attachments)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        analysisId,
        seq,
        message.author,
        message.text,
        message.variant ?? null,
        message.fixture ?? false,
        message.attachments ? JSON.stringify(message.attachments) : null,
      ],
    );
  }
  await touch(analysisId);
}

/** Replaced wholesale: a new upload is a fresh reading, not an amendment. */
export async function replaceFields(analysisId: string, fields: ReviewField[]): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM extracted_field WHERE analysis_id = $1', [analysisId]);

  for (const field of fields) {
    await pool.query(
      `INSERT INTO extracted_field (analysis_id, field_key, value, value_as_printed,
                                    units_multiplier, confidence, source_page, source_text,
                                    reasoning, lesson_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        analysisId,
        field.key,
        field.value,
        field.valueAsPrinted,
        field.unitsMultiplier,
        field.confidence,
        field.sourcePage,
        field.sourceText,
        field.reasoning,
        field.lessonNote ?? null,
      ],
    );
  }
  await touch(analysisId);
}

export async function markApproved(analysisId: string, fiscalYearEnd: string): Promise<void> {
  await getPool().query(
    `UPDATE analysis SET status = 'approved', fiscal_year_end = $2, updated_at = now()
       WHERE id = $1`,
    [analysisId, fiscalYearEnd],
  );
}

export type IncomingCorrection = {
  fieldKey: string;
  from: string;
  to: string;
  context: Record<string, unknown>;
};

export async function storeCorrections(
  analysisId: string,
  batchId: string,
  corrections: IncomingCorrection[],
): Promise<void> {
  const pool = getPool();
  for (const correction of corrections) {
    await pool.query(
      `INSERT INTO correction (id, analysis_id, batch_id, field_key, from_value, to_value, context)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [
        analysisId,
        batchId,
        correction.fieldKey,
        correction.from,
        correction.to,
        JSON.stringify(correction.context),
      ],
    );
  }
}

export type ProposedLesson = Omit<StoredLesson, 'id' | 'decision' | 'comment'>;

export async function storeLessons(
  tenantId: string,
  analysisId: string,
  batchId: string,
  fundId: string,
  lessons: ProposedLesson[],
): Promise<StoredLesson[]> {
  const pool = getPool();
  const stored: StoredLesson[] = [];

  for (const lesson of lessons) {
    const { rows } = await pool.query(
      `INSERT INTO lesson (id, tenant_id, analysis_id, batch_id, fund_id, type, scope,
                           field_keys, explanation, rule, units_multiplier,
                           document_label, confidence)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, type, scope, field_keys, explanation, rule, units_multiplier,
              document_label, confidence, decision, comment`,
      [
        tenantId,
        analysisId,
        batchId,
        // A global lesson is not about any one fund, and storing one there would
        // make it invisible to every other fund's lookup.
        lesson.scope === 'global' ? null : fundId,
        lesson.type,
        lesson.scope,
        JSON.stringify(lesson.fieldKeys),
        lesson.explanation,
        lesson.rule,
        lesson.unitsMultiplier,
        lesson.documentLabel,
        lesson.confidence,
      ],
    );
    stored.push(toLesson(rows[0]));
  }
  return stored;
}

/** Returns null when the lesson does not exist or is not this tenant's. */
export async function decideLesson(
  tenantId: string,
  lessonId: string,
  decision: 'accepted' | 'rejected',
  comment: string | null,
): Promise<StoredLesson | null> {
  const { rows } = await getPool().query(
    `UPDATE lesson SET decision = $3, comment = $4, decided_at = now()
       WHERE id = $2 AND tenant_id = $1
     RETURNING id, type, scope, field_keys, explanation, rule, units_multiplier,
              document_label, confidence, decision, comment`,
    [tenantId, lessonId, decision, comment],
  );
  return rows.length > 0 ? toLesson(rows[0]) : null;
}

/**
 * The query this database exists for. Every extraction asks it: what have we
 * been told, that applies here?
 *
 * Only accepted lessons, because nothing becomes a rule without a human saying
 * so. Scope 'none' never comes back — those are the slips we agreed not to
 * learn from, and returning them would be the one-thing-with-five-labels
 * failure this project is supposed to avoid.
 */
export async function applicableLessons(
  tenantId: string,
  fundId: string,
): Promise<StoredLesson[]> {
  const { rows } = await getPool().query(
    `SELECT id, type, scope, field_keys, explanation, rule, units_multiplier,
              document_label, confidence, decision, comment
       FROM lesson
      WHERE tenant_id = $1
        AND decision = 'accepted'
        AND (scope = 'global' OR (scope = 'fund' AND fund_id = $2))
      ORDER BY type, created_at`,
    [tenantId, fundId],
  );
  return rows.map(toLesson);
}

function touch(analysisId: string): Promise<unknown> {
  return getPool().query('UPDATE analysis SET updated_at = now() WHERE id = $1', [analysisId]);
}

function toSummary(row: Record<string, unknown>): AnalysisSummary {
  return {
    id: row.id as string,
    fundId: row.fund_id as string,
    fundName: row.fund_name as string,
    status: row.status as 'draft' | 'approved',
    createdAt: iso(row.created_at),
  };
}

function toLesson(row: Record<string, unknown>): StoredLesson {
  return {
    id: row.id as string,
    type: row.type as LessonType,
    scope: row.scope as LessonScope,
    fieldKeys: row.field_keys as string[],
    explanation: row.explanation as string,
    rule: row.rule as string,
    unitsMultiplier: numeric(row.units_multiplier),
    documentLabel: (row.document_label as string) ?? '',
    confidence: row.confidence as StoredLesson['confidence'],
    ...(row.decision ? { decision: row.decision as 'accepted' | 'rejected' } : {}),
    ...(row.comment ? { comment: row.comment as string } : {}),
  };
}

function numeric(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
