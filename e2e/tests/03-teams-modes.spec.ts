import { test, expect } from '@playwright/test';
import { login, ADMIN, TINY_PNG } from './helpers';

test.describe('teams + vision + modes', () => {
  test('initial mode optimises a valid squad onto the pitch', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    await page.goto('/initial');
    await page.getByTestId('optimise-btn').click();
    const slots = page.getByTestId('pitch-slot');
    await expect(slots.first()).toBeVisible({ timeout: 60_000 });
    expect(await slots.count()).toBe(15); // 11 starters + 4 bench
    await expect(page.locator('.stat-panel')).toContainText('Formation');
    await expect(page.locator('.pitch-slot .cap').first()).toBeVisible(); // captain badge
  });

  test('create a team, upload a screenshot, confirm the parsed 15', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    await page.goto('/teams');
    await page.getByTestId('new-team-name').fill('E2E Vision Team');
    await page.getByTestId('new-team-create').click();
    await expect(page).toHaveURL(/\/teams\/\d+/);

    // upload → mock vision provider returns a deterministic 15-man parse
    const fileInput = page.locator('input[type="file"]');
    await page.getByTestId('upload-btn').click();
    await fileInput.setInputFiles({ name: 'team.png', mimeType: 'image/png', buffer: TINY_PNG });

    // MANDATORY confirmation screen — never auto-trusted
    await expect(page.getByTestId('confirm-screen')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('confirm-screen')).toContainText('Confirmation required');

    // resolve any ambiguous slots via their pickers
    const pickers = page.locator('[data-testid^="picker-"]');
    const pickerCount = await pickers.count();
    for (let i = 0; i < pickerCount; i++) {
      const picker = pickers.nth(i);
      const value = await picker.inputValue();
      if (!value) await picker.selectOption({ index: 1 });
    }
    await page.getByTestId('confirm-upload').click();

    // pitch renders the confirmed squad
    await expect(page.getByTestId('pitch-slot').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.getByTestId('pitch-slot').count()).toBe(15);
    await expect(page.getByTestId('team-valuation')).toContainText('Overall');
  });

  test('weekly mode produces suggestions for the uploaded team', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    await page.goto('/weekly');
    // the E2E Vision Team (15 players) is auto-selected
    await expect(page.locator('.stat-panel')).toContainText('Captaincy pool', { timeout: 60_000 });
    await expect(page.getByText('Best 0-transfer move')).toBeVisible();
  });

  test('chips mode shows two-set windows and coverage', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    // chip recommendations are computed per-run per-team; re-run so the
    // uploaded team gets its chip rows
    await page.goto('/run');
    await page.getByTestId('run-launch').click();
    await expect(page.getByTestId('run-stage')).toContainText(/Complete/, { timeout: 120_000 });

    await page.goto('/chips');
    await expect(page.locator('.rank-item').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/set \d/).first()).toBeVisible();
    await expect(page.locator('.stat-panel')).toContainText('coverage', { ignoreCase: true });
  });
});
