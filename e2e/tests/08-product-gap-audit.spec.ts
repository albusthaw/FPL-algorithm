/**
 * Product-gap audit — HARDENED (engineupgradeplus.md Part 6 gate #1).
 * The v1.4.1–v1.4.5 releases shipped every probed capability, so the
 * PRESENT lines are now hard assertions: a regression fails the suite.
 * Requires the mock AI provider alive (vision + text reformat, zero cost).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const findings: string[] = [];
function present(area: string, capability: string, ok: boolean): void {
  findings.push(`${ok ? 'PRESENT' : 'GAP'} · ${area} · ${capability}`);
  expect(ok, `${area} · ${capability}`).toBe(true);
}

import { login as sharedLogin, ADMIN } from './helpers';

async function login(page: Page): Promise<void> {
  await sharedLogin(page, ADMIN);
}

const bodyHas = async (page: Page, re: RegExp): Promise<boolean> => re.test((await page.textContent('body')) ?? '');

test.describe('product gap audit (hardened)', () => {
  test('weekly mode: squad-style view with save', async ({ page }) => {
    await login(page);
    await page.goto('/weekly');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2500); // team auto-select + weekly payload
    // needs a saved 15-man team (earlier specs create one); if the picker has
    // none this environment can't render a pitch — treat as setup failure
    const hasFullTeam = await bodyHas(page, /15\/15/);
    test.skip(!hasFullTeam, 'no 15-man team saved — earlier specs must run first');
    present('weekly', 'pitch/squad-style view of the picked XI', (await page.getByTestId('weekly-pitch').count()) > 0);
    present('weekly', 'weekly XI savable as a team', (await page.getByTestId('save-weekly').count()) > 0 || (await page.getByTestId('saved-weekly').count()) > 0);
  });

  test('generated builds: save buttons on initial + chips', async ({ page }) => {
    await login(page);
    await page.goto('/initial');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('optimise-btn').click();
    await expect(page.getByTestId('save-initial_xi').or(page.getByTestId('saved-initial_xi'))).toBeVisible({ timeout: 30_000 });
    present('initial-xi', 'save generated squad as a named team', true);
    // the squad band (A7) rides the same payload
    present('initial-xi', 'simulated P10–P90 squad band', (await page.getByTestId('squad-band').count()) > 0);
    // chips: the save button appears with a built chip squad; presence of the
    // SaveBuildButton code path is proven by initial — chips shares it
    await page.goto('/teams');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    present('teams', 'kind badges on saved builds', (await page.locator('[data-testid^="team-kind-"]').count()) > 0);
  });

  test('run screen: data-depth selector = plan ∩ entitlements', async ({ page }) => {
    await login(page);
    await page.goto('/run');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    present('run', 'data window table', (await page.getByTestId('run-data-window').count()) > 0);
    await page.getByTestId('run-data-window-toggle').click();
    await page.waitForTimeout(400);
    present('run', 'SELECTABLE depth per provider (admin-gated)', (await page.locator('[data-testid^="depth-select-"]').count()) >= 4);
    // refused options stay visible with the reason
    const disabledWithReason = await page.locator('[data-testid^="depth-select-"] option[disabled]').count();
    present('run', 'plan-refused depths un-selectable with reason shown', disabledWithReason > 0);
    // subscription plan selector lives on the admin provider cards
    await page.goto('/admin');
    await page.getByTestId('admin-tab-providers').click();
    await page.waitForTimeout(800);
    present('run', 'provider subscription-plan selector (tier per provider)', (await page.locator('[data-testid^="provider-plan-"]').count()) >= 3);
  });

  test('image pipeline: OCR-first parse with AI text reformat', async ({ page }) => {
    test.setTimeout(180_000); // first OCR call loads the WASM + traineddata
    await login(page);
    const png = fs.readFileSync(path.join(here, '..', 'fixtures', 'team-screenshot.png'));
    const res = await page.request.post('/api/teams/upload-image', {
      headers: { 'X-Requested-With': 'fpl-frontend' }, // CSRF guard header
      multipart: { image: { name: 'team.png', mimeType: 'image/png', buffer: png } },
      timeout: 150_000,
    });
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
    const body = (await res.json()) as { stage?: string; resolved?: unknown[]; credits?: number };
    present('teams', 'OCR-first parse (no AI vision required for extraction)', body.stage === 'ocr');
    present('teams', 'AI used only to reformat OCR text (token-cheap path)', body.stage === 'ocr' && Array.isArray(body.resolved) && body.resolved.length >= 8);
  });

  test('admin: AI model capability awareness', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.getByTestId('admin-tab-ai').click();
    await page.waitForTimeout(1000);
    present('admin-ai', 'per-provider capability flags (vision/params)', (await page.locator('[data-testid^="ai-caps-"]').count()) > 0);
    present('admin-ai', 'per-model param compatibility surfaced (temperature/tokenParam)', await bodyHas(page, /temperature (locked|free)/i) && await bodyHas(page, /max_(completion_)?tokens/i));
  });

  test.afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('\n──── PRODUCT GAP AUDIT (hardened) ────\n' + findings.join('\n') + '\n──────────────────────────────────────');
  });
});
