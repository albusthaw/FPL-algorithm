/**
 * Engine-gap audit (enginesupgrade.md evidence pass) — NOT a regression
 * suite. Each check probes the live app for a capability the engine upgrade
 * plan proposes; presence/absence is logged as an annotation and a GAP line.
 * Pages must load (hard assert); every capability probe is soft, so this
 * spec stays green while eliciting the current gaps.
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

const has = async (page: Page, selector: string): Promise<boolean> =>
  (await page.locator(selector).count()) > 0;

const bodyHas = async (page: Page, re: RegExp): Promise<boolean> => re.test((await page.textContent('body')) ?? '');

test.describe('engine liveliness gap audit', () => {
  test('dashboard: live/at-a-glance capabilities', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    gap('dashboard', 'deadline countdown to next GW', await bodyHas(page, /deadline in|counts? ?down|\d+h \d+m/i));
    gap('dashboard', 'live gameweek points board (event/live)', await bodyHas(page, /live points|live gw|minutes played/i));
    gap('dashboard', 'price-change ticker (risers/fallers)', await bodyHas(page, /price (rise|fall|change)|risers|fallers/i));
    gap('dashboard', 'news feed with signal badges', await has(page, '[data-testid*="news"]'));
    gap('dashboard', 'confirmed-lineup indicator near kickoff', await bodyHas(page, /confirmed (xi|lineup)/i));
    gap('dashboard', 'auto-refresh / SSE of dashboard data', await page.evaluate(() => 'EventSource' in window && performance.getEntriesByType('resource').some((r) => r.name.includes('/stream'))));
  });

  test('players table: per-player liveliness', async ({ page }) => {
    await login(page);
    await page.goto('/players');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
    gap('players', 'player photos (TheSportsDB cutouts probed OK)', await has(page, 'img[src*="thesportsdb"], img[data-testid*="player-photo"]'));
    gap('players', 'form sparkline / trend arrow per player', await has(page, '[data-testid*="sparkline"], svg[class*="spark"]'));
    gap('players', 'human-signal badges (v1.4.0 data exists in matrix)', await bodyHas(page, /transfer talk|disciplinary|morale/i));
    gap('players', 'price-change prediction column', await bodyHas(page, /predicted (rise|fall)/i));
    // player detail drill-down with news timeline
    const row = page.locator('tbody tr').first();
    await row.click().catch(() => undefined);
    await page.waitForTimeout(600);
    gap('players', 'player detail view with news timeline + xPts components', await bodyHas(page, /news timeline|per-fixture|component/i));
  });

  test('modes/insights: match-engine surface', async ({ page }) => {
    await login(page);
    await page.goto('/weekly');
    await expect(page.locator('main')).toBeVisible();
    gap('match', 'fixture win/draw/loss probabilities shown', await bodyHas(page, /win %|\d{1,2}% ?(win|draw)/i));
    gap('match', 'likely scoreline heatmap or top scorelines', await bodyHas(page, /scoreline|2-1|1-1 most likely/i));
    gap('match', 'head-to-head context (football-data h2h probed OK)', await bodyHas(page, /head.to.head|h2h/i));
    gap('match', 'predicted lineups pre-confirmation', await bodyHas(page, /predicted (xi|lineup)/i));
    gap('match', 'referee card-tendency context', await bodyHas(page, /referee/i));
    gap('match', 'kickoff times & venue on fixtures (TSDB rounds probed OK)', await bodyHas(page, /\d{2}:\d{2}|venue|emirates|anfield/i));
  });

  test('api surface: engine outputs not yet exposed', async ({ page, request }) => {
    await login(page);
    const insights = await request.get('/api/insights').then((r) => r.json()).catch(() => null);
    const hasProbabilities = JSON.stringify(insights ?? {}).includes('pHome') || JSON.stringify(insights ?? {}).includes('p_home');
    gap('api', 'match insights expose win/scoreline probabilities', hasProbabilities);
    const players = await request.get('/api/players').then((r) => r.json()).catch(() => null);
    const s = JSON.stringify(players ?? {});
    gap('api', 'players API exposes human_signals evidence', s.includes('human_signals'));
    gap('api', 'players API exposes per-event xpts curve', s.includes('xpts_per_event'));
    const version = await request.get('/api/health').then((r) => r.json());
    expect(version.status).toBe('ok');
  });

  test.afterAll(() => {
    // the audit deliverable: one line per capability
    // eslint-disable-next-line no-console
    console.log('\n──── ENGINE GAP AUDIT ────\n' + findings.join('\n') + '\n──────────────────────────');
  });
});
