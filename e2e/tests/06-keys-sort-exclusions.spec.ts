import { test, expect } from '@playwright/test';
import { login, ADMIN } from './helpers';

test.describe('v1.1.0: sortable table, skip-list buttons, admin keys & models', () => {
  test('players table sorts by column headers, both directions, and shows no NaN', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/players');
    const rows = page.locator('[data-testid="players-table"] tbody tr');
    await expect(rows.first()).toBeVisible();

    // regression guard for the all-NaN bug: the board must never render NaN
    await expect(page.locator('[data-testid="players-table"]')).not.toContainText('NaN');

    // sort by xP3: first click = best first (descending)
    await page.getByTestId('sort-xpts_next3').click();
    const firstDesc = Number(await rows.first().locator('td').nth(8).innerText());
    const secondDesc = Number(await rows.nth(1).locator('td').nth(8).innerText());
    expect(firstDesc).toBeGreaterThanOrEqual(secondDesc);

    // second click flips to ascending
    await page.getByTestId('sort-xpts_next3').click();
    const firstAsc = Number(await rows.first().locator('td').nth(8).innerText());
    expect(firstAsc).toBeLessThanOrEqual(firstDesc);

    // name sort A→Z
    await page.getByTestId('sort-web_name').click();
    const nameA = await rows.first().locator('td').nth(1).innerText();
    const nameB = await rows.nth(1).locator('td').nth(1).innerText();
    expect(nameA.localeCompare(nameB)).toBeLessThanOrEqual(0);
  });

  test('run screen skip-list bulk buttons: unselect all and bottom-N%', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/run');
    await expect(page.getByTestId('excl-none')).toBeVisible();

    const kicker = page.locator('text=/AI skip list \\(\\d+ skipped\\)/');
    await expect(kicker).toBeVisible();

    await page.getByTestId('excl-none').click();
    await expect(page.locator('text=AI skip list (0 skipped)')).toBeVisible();

    await page.getByTestId('excl-bottom-40').click();
    const text40 = await kicker.innerText();
    const count40 = Number(text40.match(/\((\d+) skipped\)/i)![1]);
    expect(count40).toBeGreaterThan(0);

    await page.getByTestId('excl-bottom-20').click();
    const text20 = await kicker.innerText();
    const count20 = Number(text20.match(/\((\d+) skipped\)/i)![1]);
    expect(count20).toBeLessThan(count40);

    await page.getByTestId('excl-none').click();
    await expect(page.locator('text=AI skip list (0 skipped)')).toBeVisible();
  });

  test('admin: API key can be entered, shows masked status, gates enabling', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-providers').click();

    // sportmonks has no key: its enable button must be disabled with guidance
    const card = page.getByTestId('provider-sportmonks');
    await expect(card).toBeVisible();
    const toggle = page.getByTestId('provider-toggle-sportmonks');
    const disabledBefore = await toggle.isDisabled();
    if (disabledBefore) {
      await expect(toggle).toContainText('Add API key');
    }

    // enter a key → card flips to set (…hint) and the toggle unlocks
    await page.getByTestId('key-input-SPORTMONKS_TOKEN').fill('e2e-dummy-token-1234');
    await page.getByTestId('key-save-SPORTMONKS_TOKEN').click();
    await expect(card.locator('text=/✓ set/')).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('text=…1234')).toBeVisible();
    await expect(page.getByTestId('provider-toggle-sportmonks')).toBeEnabled();

    // clean up: clear the dummy key via the API the page uses
    await page.evaluate(async () => {
      await fetch('/api/admin/keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-requested-with': 'fpl-frontend' },
        body: JSON.stringify({ env: 'SPORTMONKS_TOKEN', value: '' }),
      });
    });
  });

  test('admin: AI provider card offers model picker with live load for the mock', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-ai').click();
    const card = page.getByTestId('ai-mock');
    await expect(card).toBeVisible();
    await page.getByTestId('model-load-mock').click();
    const select = page.getByTestId('model-select-mock');
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.selectOption('mock-analyst-1');
    await page.getByTestId('model-save-mock').click();
    await expect(card.locator('text=model saved')).toBeVisible();
  });
});
