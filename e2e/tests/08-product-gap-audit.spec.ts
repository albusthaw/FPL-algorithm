/**
 * Product-gap audit (engineupgradeplus.md evidence pass) — companion to
 * 07-engine-gap-audit. Probes the four product asks: squad-style views +
 * savable generated builds, the Run data-depth selector, the OCR-first
 * image pipeline, and AI model-capability awareness. Soft checks: the spec
 * stays green while logging PRESENT/GAP lines.
 */
import { test, expect, type Page } from '@playwright/test';

const findings: string[] = [];
function gap(area: string, capability: string, present: boolean): void {
  findings.push(`${present ? 'PRESENT' : 'GAP'} · ${area} · ${capability}`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  if (await page.getByTestId('login-email').isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByTestId('login-email').fill(process.env.E2E_EMAIL ?? 'admin@fpl.minthantthaw.me');
    await page.getByTestId('login-password').fill(process.env.E2E_PASSWORD ?? '');
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/');
  }
}

const bodyHas = async (page: Page, re: RegExp): Promise<boolean> => re.test((await page.textContent('body')) ?? '');

test.describe('product gap audit', () => {
  test('weekly mode: squad-style view and savability', async ({ page }) => {
    await login(page);
    await page.goto('/weekly');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500); // let a team auto-select and data load
    // squad style = the PitchView the other modes render
    gap('weekly', 'pitch/squad-style view of the picked XI', (await page.locator('.pitch').count()) > 0);
    gap('weekly', 'suggested-XI rendered as formation with C/V armbands', await bodyHas(page, /formation/i) && (await page.locator('.pitch').count()) > 0);
  });

  test('generated builds: save buttons', async ({ page }) => {
    await login(page);
    await page.goto('/initial');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    const saveOnInitial = (await page.locator('button', { hasText: /save/i }).count()) > 0;
    gap('initial-xi', 'save generated squad as a named team', saveOnInitial);
    await page.goto('/chips');
    const saveOnChips = (await page.locator('button', { hasText: /save/i }).count()) > 0;
    gap('chips', 'save Free Hit / Wildcard build as a named team', saveOnChips);
  });

  test('run screen: data-depth selector', async ({ page }) => {
    await login(page);
    await page.goto('/run');
    await expect(page.locator('.section-title').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1200); // prepare payload populates the panel
    gap('run', 'data window table (read-only)', (await page.getByTestId('run-data-window').count()) > 0);
    gap('run', 'SELECTABLE depth (days/weeks/months/seasons) per provider+plan', (await page.locator('[data-testid*="depth-select"]').count()) > 0);
    gap('run', 'provider subscription-plan setting (free/paid tier per provider)', await bodyHas(page, /plan: (free|paid|pro)/i));
  });

  test('image pipeline: OCR-first path', async ({ page }) => {
    await login(page);
    // API-level: with no vision-capable provider alive, upload should still
    // work once an OCR-first path exists; today it 422s on the AI gate.
    // page.request shares the session cookie with the logged-in page.
    const res = await page.request.post('/api/teams/upload-image', {
      headers: { 'X-Requested-With': 'fpl-frontend' },
      multipart: { image: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') } },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // today: a non-vision alive provider (deepseek) makes this 422 "does not
    // support vision" — proving extraction is AI-vision-gated, no OCR path
    const visionGated = res.status() === 422 && /vision/i.test(body.error ?? '');
    gap('teams', 'OCR-first parse (no AI vision required for extraction)', !visionGated && res.status() < 500 && res.status() !== 400 ? true : false);
    gap('teams', 'AI used only to reformat OCR text (token-cheap path)', false); // no such path in code
  });

  test('admin: AI model capability awareness', async ({ page }) => {
    await login(page);
    await page.goto('/admin');
    await page.waitForSelector('.kicker', { timeout: 15_000 }).catch(() => undefined);
    await page
      .locator('button', { hasText: /^AI/ })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(600);
    gap('admin-ai', 'model picker shows per-model capability flags (vision/params)', await bodyHas(page, /max_completion_tokens|vision-capable|capabilit/i));
    gap('admin-ai', 'per-model param compatibility warning (temperature/max_tokens)', await bodyHas(page, /temperature (locked|unsupported)/i));
  });

  test.afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('\n──── PRODUCT GAP AUDIT ────\n' + findings.join('\n') + '\n───────────────────────────');
  });
});
