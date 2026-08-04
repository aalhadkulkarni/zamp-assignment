import { expect, test } from '@playwright/test';

/**
 * A smoke test of the deployed shape of the thing, not of its behaviour.
 *
 * The substance is covered by 242 unit and integration tests, which run against
 * a real schema and a stubbed model and can assert things a browser cannot —
 * that a units lesson becomes arithmetic, that a fund-scoped rule does not reach
 * another fund. What those cannot tell you is whether the three services are
 * wired to each other and to a database at all. That is this.
 *
 * Deliberately read-only. It creates no analysis and writes nothing, because
 * `npm run e2e` picks up whatever DATABASE_URL is configured — which may be the
 * deployed one — and a test suite that leaves rows behind in a real database is
 * a test suite people stop running.
 */
test('the app loads, and reaches the customer system through the API', async ({ page }) => {
  await page.goto('/');

  // agent-web is served, and has asked agent-api for the analysis list. What
  // proves the call is that the list resolves to one of its two real answers.
  //
  // The loading state itself is deliberately not asserted: locally the API
  // answers faster than the assertion runs, so waiting for it to be visible is
  // a race against the thing working well. Unit tests cover that it appears.
  await expect(page.getByRole('heading', { name: 'Analyses' })).toBeVisible();
  await expect(
    page.getByText('No analyses yet.').or(page.locator('.analysis-row').first()),
  ).toBeVisible({ timeout: 20_000 });

  // The fund list comes from customer-system, passed through agent-api. If
  // either is down or CUSTOMER_SYSTEM_URL is wrong, this is where it shows —
  // which is exactly how the deployed instance failed the first time.
  await page.getByRole('button', { name: 'New analysis' }).click();
  const funds = page.getByLabel('Fund');
  await expect(funds).toBeVisible();
  await expect(funds.locator('option')).toHaveCount(6); // five funds plus the placeholder
  await expect(funds).toContainText('CalPERS');

  // Nothing is created: leaving is the end of the test.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Analyses' })).toBeVisible();
});
