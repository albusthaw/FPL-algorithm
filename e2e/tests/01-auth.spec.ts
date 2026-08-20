import { test, expect } from '@playwright/test';
import { login, ADMIN } from './helpers';

test.describe('login gate', () => {
  test('unauthenticated users land on the glass login card', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('.login-card')).toBeVisible();
    await expect(page.locator('.masthead-title')).toHaveCount(0);
  });

  test('API routes refuse unauthenticated access', async ({ request }) => {
    const res = await request.get('/api/players');
    expect(res.status()).toBe(401);
  });

  test('wrong password shows an error, not a crash', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-email').fill(ADMIN.email);
    await page.getByTestId('login-password').fill('definitely-wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText(/invalid/i);
  });

  test('valid login reaches the dashboard with the token pill', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.locator('.masthead-title')).toContainText('FPL ALGORITHM');
    await expect(page.getByTestId('token-pill')).toContainText('∞'); // admin = unlimited
  });

  test('mutations without the CSRF header are refused', async ({ page, request }) => {
    await login(page, ADMIN);
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/teams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"csrf"}' });
      return r.status;
    });
    expect(res).toBe(403);
  });
});
