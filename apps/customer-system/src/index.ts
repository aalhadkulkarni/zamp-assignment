import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/health', async () => ({ ok: true, service: 'customer-system' }));

const port = Number(process.env.PORT) || 3002;
await app.listen({ port, host: '0.0.0.0' });