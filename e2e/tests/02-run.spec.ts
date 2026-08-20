import { test, expect } from '@playwright/test';
import { login, ADMIN } from './helpers';

test.describe('full run flow with the mock AI provider', () => {
  test('run screen shows pre-flight, launches, streams SSE progress to a token report', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, ADMIN);
    await page.goto('/run');

    await expect(page.getByTestId('alive-provider')).toContainText('mock');
    await page.getByTestId('run-launch').click();

    // SSE progress appears and walks the stages
    await expect(page.getByTestId('run-progress')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('run-stage')).toContainText(/Complete/, { timeout: 120_000 });
    await expect(page.getByTestId('run-report')).toContainText(/credits/i);
  });

  test('dashboard shows rankings after the run', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.getByTestId('dashboard-rankings')).toBeVisible();
    await expect(page.locator('.rank-item').first()).toBeVisible();
    await expect(page.getByTestId('dashboard-statpanel')).toContainText('Run');
  });

  test('players table renders the full board with scores', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/players');
    const rows = page.locator('[data-testid="players-table"] tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(100);
    // position filter works
    await page.getByRole('button', { name: 'GK', exact: true }).click();
    await expect(rows.first()).toContainText('GK');
  });

  test('player detail shows matrix, components and history', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/players');
    await page.locator('[data-testid="players-table"] tbody tr').first().click();
    await expect(page).toHaveURL(/\/players\/plr_/);
    await expect(page.locator('.stat-panel')).toContainText('Overall score');
    await expect(page.getByTestId('sparkline')).toBeVisible();
  });
});
