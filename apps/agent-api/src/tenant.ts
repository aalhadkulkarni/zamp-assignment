import type { FastifyRequest } from 'fastify';

/**
 * Every stored document is filed under a tenant. There is no auth yet, so this
 * resolves to a constant — but the seam exists, so adding auth later means
 * changing this function rather than every path that touches storage.
 */
const DEFAULT_TENANT = 'demo-tenant';

export function resolveTenant(_request: FastifyRequest): string {
  return DEFAULT_TENANT;
}
