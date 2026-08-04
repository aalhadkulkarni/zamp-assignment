import { fileURLToPath } from 'node:url';

// Node 22 can read a .env file itself, so there is no dotenv dependency here.
//
// fileURLToPath, not URL.pathname: pathname leaves the path percent-encoded, so
// a directory containing a space resolves to a file that does not exist.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));

try {
  process.loadEnvFile(envFile);
} catch (error) {
  // A missing file is the normal case in production, where the platform sets
  // the environment directly. Anything else — unreadable, malformed — is a real
  // problem, and swallowing it once already hid a bug.
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`Could not read ${envFile}:`, error);
  }
}

const { buildApp } = await import('./app.js');
const { migrate } = await import('./db.js');
const { startListening } = await import('./events.js');
const { failAbandonedWork } = await import('./analyses.js');

const production = process.env.NODE_ENV === 'production';

if (process.env.DATABASE_URL) {
  await migrate();
} else if (production) {
  // No degraded mode in production: an analysis is the product, and without
  // somewhere to keep one there is nothing to serve. Failing at boot with the
  // variable named beats failing on the first request.
  console.error('DATABASE_URL is not set. agent-api cannot start without a database.');
  process.exit(1);
} else {
  // Locally, a missing database means someone has just cloned this and wants to
  // see it work. Making them provision Postgres before they can look at
  // anything is a bad first ten minutes, so it runs in memory instead — the
  // real schema, the real SQL, and nothing kept.
  console.warn(
    'DATABASE_URL is not set — running against an in-memory database.\n' +
      '  Everything works, and nothing survives a restart.\n' +
      '  Set DATABASE_URL in apps/agent-api/.env to keep your analyses.',
  );
  const { startTestDatabase } = await import('./testing.js');
  await startTestDatabase();
}

// Anything left mid-flight belonged to a process that no longer exists, so
// nothing will ever finish or report it. This is the only moment we can be
// certain of that, and without it a browser waits on a notification that is
// never coming.
const abandoned = await failAbandonedWork();
if (abandoned > 0) {
  console.warn(`Marked ${abandoned} job(s) as failed — they did not survive a restart.`);
}

// One LISTEN connection per instance. Everything that changes an analysis
// announces it through the database, so the browser waiting on an event stream
// hears about it even when the work ran on a different instance.
await startListening();

// Same reasoning as the database. A fresh clone has no API key, and a demo that
// cannot demonstrate anything is worse than one that says it is using a
// recording. Never in production: a deployed service that quietly served
// fixtures because it lost its key is precisely the failure this guards against.
if (!production && !process.env.ANTHROPIC_API_KEY && process.env.USE_FIXTURES === undefined) {
  process.env.USE_FIXTURES = 'true';
  console.warn('No ANTHROPIC_API_KEY — using recorded replies. Set one to make real calls.');
}

if (process.env.USE_FIXTURES === 'true') {
  // Loud on purpose. A recorded reply is indistinguishable from a real one in
  // the UI, so the log is the only place this is visible.
  console.warn('USE_FIXTURES=true — replies are recorded, the model is not called.');
} else if (!process.env.ANTHROPIC_API_KEY) {
  // A warning rather than a crash: uploads work without a key, and a service
  // that refuses to start is harder to diagnose than one that says what is
  // missing. The upload response carries the same message in agentError.
  console.warn('ANTHROPIC_API_KEY is not set — uploads will report NotConfigured.');
}

const app = await buildApp();
const port = Number(process.env.PORT) || 3001;
await app.listen({ port, host: '0.0.0.0' });
