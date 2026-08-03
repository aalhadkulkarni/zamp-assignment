import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite ships with Node 22, so this costs no dependency. The API is marked
 * experimental, which is why the repo pins Node 22 in .nvmrc and engines.
 *
 * On Render's free tier the filesystem is ephemeral, so this file is wiped on
 * every redeploy, restart and spin-down. Locally it persists. Making it durable
 * in production is a paid instance with a disk attached, not a rewrite — nothing
 * above this module knows where the rows live.
 */
export function databasePath(): string {
  const configured = process.env.CUSTOMER_DB ?? '.data/customer.db';
  // ':memory:' is a sentinel, not a path. Resolving it produces a real file of
  // that name, which is how every test ended up sharing one database.
  return configured === ':memory:' ? configured : resolve(configured);
}

/**
 * Every constraint here is one the customer imposes on us. They are the reason
 * a write can genuinely be rejected rather than politely accepted.
 *
 * There is deliberately no arithmetic check tying net_position to assets minus
 * liabilities. The real identity also involves deferred outflows and inflows,
 * which we do not collect — for CalPERS PERF A the two sides differ by exactly
 * those amounts. Encoding an invariant that is subtly wrong is worse than
 * encoding none.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fund (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS report (
    id                TEXT PRIMARY KEY,
    fund_id           TEXT NOT NULL REFERENCES fund(id),
    fiscal_year_end   TEXT NOT NULL,

    total_receivables INTEGER NOT NULL CHECK (total_receivables >= 0),
    total_investments INTEGER NOT NULL CHECK (total_investments >= 0),
    total_assets      INTEGER NOT NULL CHECK (total_assets > 0),
    total_liabilities INTEGER NOT NULL CHECK (total_liabilities >= 0),
    net_position      INTEGER NOT NULL,

    created_at        TEXT NOT NULL,

    -- One statement per plan per year. Re-submitting the same document is a
    -- mistake, not an update.
    UNIQUE (fund_id, fiscal_year_end)
  );
`;

/**
 * Large US public pension systems, each the whole system rather than the plans
 * inside it. A CalPERS statement puts six plans side by side as columns, so
 * "Total Investments" is several numbers on one page — working out which one the
 * schema wants is extraction's problem, not something the fund list should
 * pre-empt.
 *
 * Five is enough variety to learn per-issuer lessons against.
 */
const SEED_FUNDS: [string, string][] = [
  ['calpers', 'CalPERS — California Public Employees’ Retirement System'],
  ['calstrs', 'CalSTRS — California State Teachers’ Retirement System'],
  ['nyscrf', 'New York State Common Retirement Fund'],
  ['trs-texas', 'Teacher Retirement System of Texas'],
  ['florida-sba', 'Florida Retirement System Pension Plan'],
];

export function openDatabase(): DatabaseSync {
  const path = databasePath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // Off by default in SQLite, so the fund_id reference would not be enforced.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // DO UPDATE rather than DO NOTHING so a renamed fund propagates to an existing
  // database. Funds removed from this list would linger; there is no migration
  // story yet and nothing depends on one.
  const insert = db.prepare(
    'INSERT INTO fund (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name',
  );
  for (const [id, name] of SEED_FUNDS) insert.run(id, name);

  return db;
}
