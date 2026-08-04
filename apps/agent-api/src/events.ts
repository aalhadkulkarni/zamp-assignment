import { EventEmitter } from 'node:events';
import pg from 'pg';
import { getPool, reachedOverPublicNetwork } from './db.js';

/**
 * Telling a browser that an analysis has changed.
 *
 * The path is always the same shape: something changes an analysis and calls
 * `analysisChanged`, which issues a Postgres NOTIFY. Every instance of this
 * service holds one LISTEN connection, receives that notification — including
 * the instance that sent it — and re-emits it locally, where the open SSE
 * responses are waiting.
 *
 * Routing through the database rather than an in-process emitter is what makes
 * this work with more than one instance running. The browser's SSE connection
 * and the extraction it is waiting for are separate requests, and nothing makes
 * them land on the same process. An in-memory bus would drop the notification
 * silently whenever they did not — and would reintroduce the single-instance
 * ceiling that was the reason for choosing Postgres over SQLite in the first
 * place.
 *
 * The payload is only an id. What changed is fetched by the client afterwards,
 * so there is one description of an analysis rather than two that can disagree,
 * and no risk of an 8000-byte NOTIFY limit deciding what the UI can show.
 */

const CHANNEL = 'analysis_changed';

const local = new EventEmitter();
// One SSE response per connected browser tab, and a few tabs is normal. The
// default limit of 10 is a leak warning, and these are not leaks.
local.setMaxListeners(0);

let listener: pg.Client | null = null;
let listening: Promise<void> | null = null;
let inProcessOnly = false;

/**
 * Makes notifications bypass Postgres and emit directly.
 *
 * pg-mem cannot parse LISTEN or NOTIFY, so the test suite has no database that
 * can carry them. This is the seam — the same shape as `useTestPool`. It is
 * worth being clear about what it costs: the tests exercise everything either
 * side of the notification but not the notification itself, so the LISTEN path
 * is only ever proven against real Postgres.
 */
export function useInProcessEvents(): void {
  inProcessOnly = true;
}

export async function analysisChanged(analysisId: string): Promise<void> {
  if (inProcessOnly) {
    local.emit(CHANNEL, analysisId);
    return;
  }

  // pg_notify rather than NOTIFY, because the channel and payload are then
  // bound parameters instead of string-interpolated SQL.
  await getPool().query('SELECT pg_notify($1, $2)', [CHANNEL, analysisId]);
}

/** Returns the unsubscribe. Callers are SSE responses, which always end. */
export function onAnalysisChanged(
  analysisId: string,
  handler: () => void,
): () => void {
  const relay = (changed: string) => {
    if (changed === analysisId) handler();
  };
  local.on(CHANNEL, relay);
  return () => local.off(CHANNEL, relay);
}

/**
 * Opens the one connection this instance listens on.
 *
 * Called at boot and again whenever the connection drops. A dropped listener is
 * silent — every NOTIFY after it simply goes nowhere — so it reconnects rather
 * than waiting to be noticed.
 */
export async function startListening(): Promise<void> {
  if (inProcessOnly) return;
  if (listening) return listening;

  listening = (async () => {
    const client = new pg.Client(connectionOptions());
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);

    client.on('notification', (message) => {
      if (message.payload) local.emit(CHANNEL, message.payload);
    });

    client.on('error', () => {
      listener = null;
      listening = null;
      // Anything waiting on this instance is now waiting on nothing, so retry
      // rather than leaving the connection quietly dead.
      setTimeout(() => void startListening().catch(() => {}), 1000);
    });

    listener = client;
  })();

  return listening;
}

export async function stopListening(): Promise<void> {
  const client = listener;
  listener = null;
  listening = null;
  await client?.end();
}

function connectionOptions(): pg.ClientConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  return {
    connectionString,
    // The same rule as the pool, from the same function. See db.ts.
    ssl: reachedOverPublicNetwork(connectionString) ? { rejectUnauthorized: false } : undefined,
  };
}
