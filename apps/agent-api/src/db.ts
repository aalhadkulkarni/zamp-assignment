import pg from 'pg';

/**
 * Postgres, because of one query.
 *
 * Everything else this service stores would be happy in a file. The learning
 * loop would not: on every extraction it has to fetch the accepted lessons that
 * apply to a fund — those scoped to that fund plus those scoped globally —
 * grouped by type, from a table that grows with every analysis. That is a
 * filtered, indexed read across records, which is what a relational database is
 * for and what a directory of JSON files is worst at.
 *
 * The alternative worth taking seriously was SQLite on a persistent disk. It
 * fails on the same point for a different reason: one writer, one instance, so
 * the service could never run more than one copy of itself. For a stand-in like
 * customer-system that is irrelevant. For a service we own it is a ceiling.
 */
let pool: pg.Pool | null = null;

/** Lets the tests run the real schema against pg-mem, with no server. */
export function useTestPool(testPool: pg.Pool): void {
  pool = testPool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. agent-api cannot store anything without it.');
    }
    pool = new pg.Pool({
      connectionString,
      // TLS only when the database is reached over a public network, which is
      // what a dotted hostname means here. Render's internal address is a bare
      // host on their private network and localhost is a socket away — both
      // would be asking for TLS from something not offering it.
      //
      // Where TLS is used, the certificate goes unverified: managed providers
      // terminate with a chain this client does not carry, and refusing to
      // connect over that would be principled and useless. The connection is
      // still encrypted.
      ssl: reachedOverPublicNetwork(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

/**
 * A dotted hostname means the internet: Render's external address, Neon,
 * Supabase. A bare host is Render's private network, and localhost is local.
 */
export function reachedOverPublicNetwork(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    return hostname.includes('.') && hostname !== '127.0.0.1';
  } catch {
    // An unparseable string is about to fail at connect time and say so more
    // clearly than a guess about its transport would.
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

/**
 * Applied on boot. One statement per concept, all `IF NOT EXISTS`, so starting
 * the service against an existing database is a no-op rather than a migration
 * story we do not yet need.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analysis (
    id              uuid PRIMARY KEY,
    tenant_id       text NOT NULL,
    fund_id         text NOT NULL,
    fund_name       text NOT NULL,
    status          text NOT NULL DEFAULT 'draft',
    fiscal_year_end text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Extraction state is deliberately a separate axis from status. An analysis
    -- is a draft whether or not the agent happens to be reading a document for
    -- it right now, and folding a transient job into the lifecycle would mean a
    -- crash left an analysis permanently in a state it cannot leave.
    extraction_state      text NOT NULL DEFAULT 'idle',
    extraction_error      text,
    extraction_started_at timestamptz,
    CHECK (status IN ('draft', 'approved')),
    CHECK (extraction_state IN ('idle', 'running', 'failed'))
  );

  -- The pages, not a path to them. Render's filesystem is wiped on every
  -- restart, and a diagnosis that cannot see the page loses three of the five
  -- lesson types. Bytes in the row is the smallest thing that survives a deploy.
  CREATE TABLE IF NOT EXISTS document (
    id          uuid PRIMARY KEY,
    analysis_id uuid NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    upload_id   uuid NOT NULL,
    filename    text NOT NULL,
    extension   text NOT NULL,
    size_bytes  integer NOT NULL,
    bytes       bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS message (
    id          uuid PRIMARY KEY,
    analysis_id uuid NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    seq         integer NOT NULL,
    author      text NOT NULL,
    body        text NOT NULL,
    variant     text,
    fixture     boolean NOT NULL DEFAULT false,
    attachments jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  -- Replaced wholesale on each extraction: a new upload is a fresh reading of
  -- the documents, not an amendment to the last one.
  CREATE TABLE IF NOT EXISTS extracted_field (
    analysis_id      uuid NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    field_key        text NOT NULL,
    value            numeric,
    value_as_printed numeric,
    units_multiplier numeric NOT NULL,
    confidence       text NOT NULL,
    source_page      integer,
    source_text      text NOT NULL,
    reasoning        text NOT NULL,
    -- Set when a ratified lesson changed this row after the model answered.
    lesson_note      text,
    PRIMARY KEY (analysis_id, field_key)
  );

  -- One row per corrected field, tied to the batch it was submitted in. The
  -- batch is the unit that gets diagnosed, so it has to survive as a group.
  CREATE TABLE IF NOT EXISTS correction (
    id          uuid PRIMARY KEY,
    analysis_id uuid NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    batch_id    uuid NOT NULL,
    field_key   text NOT NULL,
    from_value  text NOT NULL,
    to_value    text NOT NULL,
    context     jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS lesson (
    id          uuid PRIMARY KEY,
    tenant_id   text NOT NULL,
    analysis_id uuid REFERENCES analysis(id) ON DELETE SET NULL,
    batch_id    uuid,
    fund_id     text,
    type        text NOT NULL,
    scope       text NOT NULL,
    field_keys  jsonb NOT NULL,
    explanation text NOT NULL,
    rule        text NOT NULL,
    -- The two typed payloads. A units lesson is a number we do arithmetic with;
    -- a synonym is the exact printed label we hand to the next extraction. Both
    -- are nullable because most lessons are neither.
    units_multiplier numeric,
    document_label   text NOT NULL DEFAULT '',
    confidence  text NOT NULL,
    decision    text,
    comment     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz,
    CHECK (scope IN ('none', 'fund', 'global')),
    CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
    -- A fund-scoped lesson without a fund is meaningless, and would silently
    -- widen or vanish when applied.
    CHECK (scope <> 'fund' OR fund_id IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS lesson_applicable
    ON lesson (tenant_id, scope, fund_id);

  CREATE INDEX IF NOT EXISTS message_by_analysis ON message (analysis_id, seq);
  CREATE INDEX IF NOT EXISTS analysis_by_tenant ON analysis (tenant_id, created_at DESC);

  -- CREATE TABLE IF NOT EXISTS is a no-op against a database that already has
  -- the table, so columns added after the first deploy need saying twice. Both
  -- forms are idempotent, and keeping them beside each other is what stops a
  -- new column existing locally and not in production.
  ALTER TABLE lesson ADD COLUMN IF NOT EXISTS units_multiplier numeric;
  ALTER TABLE lesson ADD COLUMN IF NOT EXISTS document_label text NOT NULL DEFAULT '';
  ALTER TABLE extracted_field ADD COLUMN IF NOT EXISTS lesson_note text;
  ALTER TABLE analysis ADD COLUMN IF NOT EXISTS extraction_state text NOT NULL DEFAULT 'idle';
  ALTER TABLE analysis ADD COLUMN IF NOT EXISTS extraction_error text;
  ALTER TABLE analysis ADD COLUMN IF NOT EXISTS extraction_started_at timestamptz;
`;

export async function migrate(): Promise<void> {
  await getPool().query(SCHEMA);
}
