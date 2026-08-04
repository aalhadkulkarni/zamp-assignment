import { newDb } from 'pg-mem';
import { migrate, useTestPool } from './db.js';
import { useInProcessEvents } from './events.js';

/**
 * A real Postgres for the tests, in memory, with no server to install or run.
 *
 * The alternative was mocking the repository, which would have tested that our
 * mocks agree with themselves. Here the actual schema is created and the actual
 * SQL runs — constraints, foreign keys and all — so a query that would fail
 * against Postgres fails here too.
 *
 * pg-mem does not ship gen_random_uuid, which the schema leans on for ids, and
 * it cannot parse LISTEN or NOTIFY at all — so notifications are switched to an
 * in-process emitter here. Everything either side of the notification is
 * exercised; the LISTEN path itself is only proven against real Postgres.
 */
export async function startTestDatabase(): Promise<void> {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid' as never,
    implementation: () => crypto.randomUUID(),
  });

  useTestPool(new (mem.adapters.createPg().Pool)());
  useInProcessEvents();
  await migrate();
}
