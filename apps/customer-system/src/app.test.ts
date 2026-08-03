import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { FIELD_KEYS } from './fields.js';

/**
 * Each test gets its own in-memory database, so a write in one cannot make
 * another pass or fail. The schema and constraints are identical either way.
 */
let app: Awaited<ReturnType<typeof buildApp>>;

const FUND = 'calpers';

/** Real PERF A figures from the CalPERS statement, converted from thousands to whole USD. */
const PERF_A = {
  total_receivables: 38_456_658_000,
  total_investments: 462_090_073_000,
  total_assets: 508_215_927_000,
  total_liabilities: 98_831_325_000,
  net_position: 409_424_367_000,
};

beforeEach(async () => {
  process.env.CUSTOMER_DB = ':memory:';
  app = await buildApp();
});

async function post(body: object, fundId = FUND) {
  const res = await app.inject({
    method: 'POST',
    url: `/funds/${fundId}/reports`,
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

const report = (overrides: Record<string, unknown> = {}) => ({
  fiscalYearEnd: '2025-06-30',
  values: { ...PERF_A },
  ...overrides,
});

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true, service: 'customer-system' });
  });
});

describe('GET /funds', () => {
  it('lists the funds an analyst can be assigned', async () => {
    const res = await app.inject({ method: 'GET', url: '/funds' });
    const funds = res.json();

    expect(res.statusCode).toBe(200);
    expect(funds).toHaveLength(5);
    // A fund is the whole system. Which of its plans a figure came from is
    // extraction's problem, not something the fund list settles in advance.
    expect(funds.find((f: { id: string }) => f.id === 'calpers')).toMatchObject({
      name: expect.stringContaining('CalPERS'),
    });
    expect(funds.every((f: object) => !('issuer' in f))).toBe(true);
  });
});

describe('GET /field-definitions', () => {
  it('publishes the contract agent-api maps into', async () => {
    const res = await app.inject({ method: 'GET', url: '/field-definitions' });
    const fields = res.json();

    expect(fields.map((f: { key: string }) => f.key)).toEqual(FIELD_KEYS);
    expect(fields.every((f: { unit: string }) => f.unit === 'USD')).toBe(true);
  });

  it('does not leak our synonyms into the customer contract', async () => {
    const res = await app.inject({ method: 'GET', url: '/field-definitions' });

    // "Plan Net Assets" and friends are things we learn about issuers. They are
    // not part of what the customer promises to accept.
    expect(JSON.stringify(res.json())).not.toMatch(/Plan Net Assets/i);
  });
});

describe('POST /funds/:fundId/reports', () => {
  it('stores a valid report', async () => {
    const { status, body } = await post(report());

    expect(status).toBe(201);
    expect(body).toMatchObject({ fundId: FUND, fiscalYearEnd: '2025-06-30' });
    expect(body.values).toEqual(PERF_A);
  });

  it('keeps figures this large intact', async () => {
    await post(report());
    const res = await app.inject({ method: 'GET', url: `/funds/${FUND}/reports` });

    // $462bn in whole dollars overflows a 32-bit int. It has to come back
    // exactly as it went in.
    expect(res.json()[0].total_investments).toBe(462_090_073_000);
  });

  describe('rejections', () => {
    it('refuses a fund it does not know', async () => {
      const { status, body } = await post(report(), 'not-a-fund');
      expect(status).toBe(404);
      expect(body.error).toBe('UnknownFund');
    });

    /** The demo rejection: upload the same document twice. */
    it('refuses a second report for the same fund and year', async () => {
      expect((await post(report())).status).toBe(201);

      const { status, body } = await post(report());
      expect(status).toBe(409);
      expect(body.error).toBe('ReportAlreadyExists');
      expect(body.message).toMatch(/2025-06-30/);
    });

    it('accepts a different year for the same fund', async () => {
      await post(report());
      expect((await post(report({ fiscalYearEnd: '2024-06-30' }))).status).toBe(201);
    });

    it('accepts the same year for a different fund', async () => {
      await post(report());
      expect((await post(report(), 'calstrs')).status).toBe(201);
    });

    it('names every missing field at once, not one at a time', async () => {
      const { status, body } = await post(
        report({ values: { total_assets: PERF_A.total_assets } }),
      );

      expect(status).toBe(400);
      expect(body.error).toBe('ValidationFailed');
      expect(body.problems.map((p: { field: string }) => p.field).sort()).toEqual([
        'net_position',
        'total_investments',
        'total_liabilities',
        'total_receivables',
      ]);
    });

    it('refuses a field that is not in the schema', async () => {
      const { status, body } = await post(report({ values: { ...PERF_A, funded_ratio: 0.82 } }));

      expect(status).toBe(400);
      expect(body.problems).toContainEqual({
        field: 'funded_ratio',
        reason: 'Not a field in this schema.',
      });
    });

    it('refuses a string where an amount belongs', async () => {
      const { status, body } = await post(
        report({ values: { ...PERF_A, total_assets: '$508,215,927' } }),
      );

      expect(status).toBe(400);
      expect(body.problems).toContainEqual({
        field: 'total_assets',
        reason: 'Must be a number.',
      });
    });

    /** A fraction here usually means a units conversion went wrong upstream. */
    it('refuses a fractional amount', async () => {
      const { status, body } = await post(
        report({ values: { ...PERF_A, total_investments: 462_090_073.5 } }),
      );

      expect(status).toBe(400);
      expect(body.problems).toContainEqual({
        field: 'total_investments',
        reason: 'Must be a whole number of USD.',
      });
    });

    it('refuses a negative asset total', async () => {
      const { status, body } = await post(report({ values: { ...PERF_A, total_assets: -1 } }));

      expect(status).toBe(400);
      expect(body.problems[0].field).toBe('total_assets');
    });

    it('refuses a fiscal year end that is not a date', async () => {
      const { status, body } = await post(report({ fiscalYearEnd: 'FY2025' }));
      expect(status).toBe(400);
      expect(body.error).toBe('InvalidFiscalYearEnd');
    });

    it('stores nothing when a report is rejected', async () => {
      await post(report({ values: { total_assets: PERF_A.total_assets } }));

      const res = await app.inject({ method: 'GET', url: `/funds/${FUND}/reports` });
      expect(res.json()).toEqual([]);
    });
  });
});

describe('GET /funds/:fundId/reports', () => {
  it('returns what was written, newest year first', async () => {
    await post(report({ fiscalYearEnd: '2024-06-30' }));
    await post(report());

    const res = await app.inject({ method: 'GET', url: `/funds/${FUND}/reports` });
    expect(res.json().map((r: { fiscal_year_end: string }) => r.fiscal_year_end)).toEqual([
      '2025-06-30',
      '2024-06-30',
    ]);
  });

  it('404s for an unknown fund rather than returning nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/funds/not-a-fund/reports' });
    expect(res.statusCode).toBe(404);
  });
});
