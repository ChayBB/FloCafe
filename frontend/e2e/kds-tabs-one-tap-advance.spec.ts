import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';

test('KDS tabs view advances an item one stage per switch tap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const loginRes = await page.request.post(`${E2E_BASE_URL}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: 'E2ePass123!' },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token } = await loginRes.json();

  const orderRes = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    data: { type: 'dine_in', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();
  const orderNumStr = `#${order.order_number}`;

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace'))).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  await page.getByRole('button', { name: 'Tabs' }).click();

  const tab = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
  const card = page.locator('div.bg-card.rounded-xl').filter({ hasText: orderNumStr }).first();
  const advance = card.getByTestId('kds-status-switch').first();

  // Waiting -> Preparing
  await expect(advance).toBeVisible({ timeout: 10000 });
  await expect(advance).toHaveAttribute('aria-label', 'Mark as Preparing');
  await advance.click();

  await tab('Preparing').click();
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(advance).toHaveAttribute('aria-label', 'Mark as Ready', { timeout: 10000 });

  // Preparing -> Ready
  await advance.click();
  await tab('Ready').click();
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(advance).toHaveAttribute('aria-label', 'Mark as Delivered', { timeout: 10000 });

  // Ready -> Delivered; last stage has no switch
  await advance.click();
  await tab('Delivered').click();
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByTestId('kds-status-switch')).toHaveCount(0);

  await tab('Waiting').click();
  await expect(page.locator('div.bg-card.rounded-xl').filter({ hasText: orderNumStr })).toHaveCount(0);
});
