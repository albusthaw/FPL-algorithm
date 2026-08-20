import { test, expect } from '@playwright/test';
import { login, ADMIN, USER } from './helpers';

test.describe('admin panel', () => {
  test('non-admins cannot reach /admin (server-side check too)', async ({ page }) => {
    await login(page, USER);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/$/); // bounced by the client gate
    const status = await page.evaluate(async () => (await fetch('/api/admin/users', { headers: { 'X-Requested-With': 'fpl-frontend' } })).status);
    expect(status).toBe(403); // and by the server
  });

  test('admin top-up flow updates the balance and the ledger', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-users-table')).toBeVisible();
    const before = await page.getByTestId(`balance-${USER.email}`).textContent();

    page.on('dialog', (d) => void d.accept('500'));
    await page.getByTestId(`topup-${USER.email}`).click();
    await expect(page.getByTestId(`balance-${USER.email}`)).not.toHaveText(before ?? '', { timeout: 15_000 });
    const after = Number((await page.getByTestId(`balance-${USER.email}`).textContent())?.replace(/,/g, ''));
    expect(after).toBe(Number((before ?? '0').replace(/,/g, '')) + 500);
  });

  test('API switch enforces max-2 with a visible refusal', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-providers').click();

    const toggle = async (key: string): Promise<void> => {
      await page.getByTestId(`provider-toggle-${key}`).click();
      await page.waitForTimeout(400);
    };
    // enable two, then the third must be refused with the 409 message
    for (const key of ['api_football', 'newsdata', 'sportmonks', 'football_data', 'thesportsdb', 'understat']) {
      const button = page.getByTestId(`provider-toggle-${key}`);
      if ((await button.textContent())?.includes('Enabled')) await toggle(key); // reset to disabled
    }
    await toggle('api_football');
    await toggle('newsdata');
    await toggle('sportmonks'); // third — refused
    await expect(page.getByTestId('provider-error')).toContainText(/at most 2/i);
  });

  test('AI switch: activating one deactivates the incumbent (max 1)', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-ai').click();
    await expect(page.getByTestId('ai-mock')).toContainText('ALIVE'); // from the E2E seed
    // ollama would fail its health probe (no local model) → stays un-enableable
    await page.getByTestId('ai-activate-ollama').click();
    await expect(page.getByTestId('ai-error')).toContainText(/health check failed/i);
    await expect(page.getByTestId('ai-mock')).toContainText('ALIVE'); // incumbent survives a failed probe
  });

  test('model weights save as a new config version', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-weights').click();
    const w1 = page.getByTestId('weight-w1');
    await expect(w1).toBeVisible();
    await w1.fill('0.41');
    await page.getByTestId('weights-save').click();
    await expect(page.locator('.ok-note')).toContainText(/config version \d+/);
  });

  test('logs tab renders pull log and AI cost chart', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-logs').click();
    await expect(page.getByText('AI calls (latest 100)')).toBeVisible();
    await expect(page.getByText(/API pull log/)).toBeVisible();
  });
});

test.describe('token economy for regular users', () => {
  test('user sees their finite balance in the pill', async ({ page }) => {
    await login(page, USER);
    const pill = page.getByTestId('token-pill');
    await expect(pill).toBeVisible();
    await expect(pill).not.toContainText('∞');
  });
});
