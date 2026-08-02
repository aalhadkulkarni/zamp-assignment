import { test, expect } from '@playwright/test';

test('both services report healthy', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('"service":"agent-api"')).toBeVisible();
  await expect(page.getByText('"service":"customer-system"')).toBeVisible();
});