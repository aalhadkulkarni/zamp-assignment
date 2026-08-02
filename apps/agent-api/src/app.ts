import Fastify from 'fastify';
import cors from '@fastify/cors';

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  app.get('/health', async () => ({ ok: true, service: 'agent-api' }));
  return app;
}