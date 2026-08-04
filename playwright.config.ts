import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'npm run dev',
    env: {
      // Nothing outside this machine. Empty rather than absent, so these beat
      // whatever apps/agent-api/.env contains: no database of anyone's is
      // touched, and no model is called or paid for.
      //
      // agent-api falls back to an in-memory Postgres — the real schema and the
      // real SQL, kept nowhere — and to recorded replies. Both announce
      // themselves at startup.
      DATABASE_URL: '',
      ANTHROPIC_API_KEY: '',
      USE_FIXTURES: 'true',
      FIXTURE_DELAY_MS: '0',
    },
    // Waits for agent-api, not for vite. Vite serves in about a second and
    // agent-api takes longer, so waiting on the page meant the first test ran
    // against a backend that was not up and saw the browser's own "could not
    // reach the server" error.
    url: 'http://localhost:3001/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});