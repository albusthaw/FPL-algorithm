import { test, expect } from '@playwright/test';
import { login, ADMIN, assertNoHorizontalOverflow } from './helpers';

/**
 * The §12.2 visual QA gate: every page at 360/480/768/1024/1440 with
 * scrollWidth <= clientWidth asserted — no horizontal page scroll, ever.
 * Wide tables must scroll inside .table-wrap, never the page.
 */
const WIDTHS = [360, 480, 768, 1024, 1440] as const;
const PAGES = [
  { path: '/', name: 'dashboard' },
  { path: '/players', name: 'players' },
  { path: '/run', name: 'run' },
  { path: '/initial', name: 'initial' },
  { path: '/chips', name: 'chips' },
  { path: '/weekly', name: 'weekly' },
  { path: '/teams', name: 'teams' },
  { path: '/admin', name: 'admin' },
] as const;

for (const width of WIDTHS) {
  test.describe(`viewport ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`login page fits at ${width}px`, async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('load');
      await page.waitForTimeout(600);
      await assertNoHorizontalOverflow(page);
    });

    test(`all app pages fit at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await login(page, ADMIN);
      for (const target of PAGES) {
        await page.goto(target.path);
        // NOT networkidle: the dashboard holds a live SSE stream open (X2,
        // v1.4.4) so the network never idles — by design
        await page.waitForLoadState('load');
        await page.waitForTimeout(900);
        await assertNoHorizontalOverflow(page, `${target.name}@${width}`);
      }
    });

    if (width < 768) {
      test(`mobile drawer nav works at ${width}px`, async ({ page }) => {
        await login(page, ADMIN);
        await expect(page.locator('.masthead-nav-row')).toBeHidden();
        await page.locator('.menu-toggle').click();
        await expect(page.locator('.mobile-drawer.open')).toBeVisible();
        await page.locator('.mobile-drawer a', { hasText: 'Players' }).click();
        await expect(page).toHaveURL(/\/players/);
        await assertNoHorizontalOverflow(page);
      });
    }
  });
}
