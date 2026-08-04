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

// Unlike a missing API key, there is no degraded mode here: an analysis is the
// product, and without somewhere to keep one there is nothing to serve. Failing
// at boot with the variable named beats failing on the first request.
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. agent-api cannot start without a database.');
  process.exit(1);
}
await migrate();

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
