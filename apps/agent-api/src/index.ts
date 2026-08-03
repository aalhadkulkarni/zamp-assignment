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

if (!process.env.ANTHROPIC_API_KEY) {
  // A warning rather than a crash: uploads work without a key, and a service
  // that refuses to start is harder to diagnose than one that says what is
  // missing. /llm/* returns 503 with the same message.
  console.warn('ANTHROPIC_API_KEY is not set — /llm/* will return 503.');
}

const app = await buildApp();
const port = Number(process.env.PORT) || 3001;
await app.listen({ port, host: '0.0.0.0' });
