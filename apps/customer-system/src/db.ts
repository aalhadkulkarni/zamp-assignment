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
    id     TEXT PRIMARY KEY,
    name   TEXT NOT NULL,
    issuer TEXT NOT NULL
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
 * The plans on a real CalPERS statement of fiduciary net position, plus CalSTRS
 * so there is more than one issuer to learn about. Six of these sit side by side
 * as columns on one page, which is why a fund is a plan and not an issuer.
 */
const SEED_FUNDS: [string, string, string][] = [
  ['calpers-perf-a', 'PERF A — Agent Multiple-Employer', 'CalPERS'],
  ['calpers-perf-b', 'PERF B — Schools Cost-Sharing', 'CalPERS'],
  ['calpers-perf-c', 'PERF C — Public Agency Cost-Sharing', 'CalPERS'],
  ['calpers-lrf', "Legislators' Retirement Fund", 'CalPERS'],
  ['calpers-jrf', "Judges' Retirement Fund", 'CalPERS'],
  ['calpers-jrf-ii', "Judges' Retirement Fund II", 'CalPERS'],
  ['calstrs-dbp', 'Defined Benefit Program', 'CalSTRS'],
];

export function openDatabase(): DatabaseSync {
  const path = databasePath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // Off by default in SQLite, so the fund_id reference would not be enforced.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const insert = db.prepare(
    'INSERT INTO fund (id, name, issuer) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
  );
  for (const [id, name, issuer] of SEED_FUNDS) insert.run(id, name, issuer);

  return db;
}
