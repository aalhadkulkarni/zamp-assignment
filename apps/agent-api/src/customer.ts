/**
 * The customer's system of record, reached over HTTP because that is what it is:
 * a separate service with its own database and its own opinions about what it
 * will accept. Nothing is imported from it — only the contract it publishes.
 *
 * The browser does not call it directly. In production this integration carries
 * per-customer credentials, and those belong server-side for the same reason the
 * Anthropic key does.
 */
export type Fund = {
  id: string;
  name: string;
};

export type FieldDefinition = {
  key: string;
  label: string;
  type: string;
  unit: string;
  required: boolean;
  description: string;
};

export class CustomerSystemError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CustomerSystemError';
    this.status = status;
  }
}

function baseUrl(): string {
  return process.env.CUSTOMER_SYSTEM_URL ?? 'http://localhost:3002';
}

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`);
  } catch {
    // A refused connection means their service is down, not that the request
    // was wrong. Saying so plainly beats a generic failure.
    throw new CustomerSystemError('The customer system could not be reached.', 0);
  }

  if (!response.ok) {
    throw new CustomerSystemError(
      `The customer system returned ${response.status}.`,
      response.status,
    );
  }

  return response.json() as Promise<T>;
}

export function listFunds(): Promise<Fund[]> {
  return get<Fund[]>('/funds');
}

export type WriteRejection = {
  status: number;
  error: string;
  message: string;
  problems?: { field: string; reason: string }[];
};

/**
 * A refusal is an outcome, not an exception. The customer rejecting a write is
 * an expected part of this flow — duplicate report, value out of range, field
 * they do not recognise — and the analyst needs to see exactly what they said.
 * Only a failure to reach them at all throws.
 */
export type WriteResult =
  | { ok: true; report: Record<string, unknown> }
  | ({ ok: false } & WriteRejection);

export async function createReport(
  fundId: string,
  fiscalYearEnd: string,
  values: Record<string, unknown>,
): Promise<WriteResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/funds/${encodeURIComponent(fundId)}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fiscalYearEnd, values }),
    });
  } catch {
    throw new CustomerSystemError('The customer system could not be reached.', 0);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (response.ok) {
    return { ok: true, report: body ?? {} };
  }

  // Passed through as they wrote it. Rewording their validation messages would
  // put us between the analyst and the system that actually refused.
  return {
    ok: false,
    status: response.status,
    error: String(body?.error ?? 'WriteRejected'),
    message: String(body?.message ?? `The customer system returned ${response.status}.`),
    problems: body?.problems as WriteRejection['problems'],
  };
}

export function listFieldDefinitions(): Promise<FieldDefinition[]> {
  return get<FieldDefinition[]>('/field-definitions');
}
