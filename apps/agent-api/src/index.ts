// Node 22 can read a .env file itself, so there is no dotenv dependency here.
// It throws when the file is absent, which is the normal case in production
// where the platform supplies the environment directly.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  // No .env — environment variables are expected to be set already.
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
