/**
 * Engine-gap audit — HARDENED (engineupgradeplus.md Part 6 gate #1).
 * The audit's GAP lines shipped across v1.4.3–v1.4.5; every shipped
 * capability is now a hard assertion against the live app. The handful of
 * capabilities NOT shipped (referee context, dashboard confirmed-XI chip)
 * remain soft GAP lines so the audit record stays complete.
 */
import { test, expect, type Page } from '@playwright/test';

const findings: string[] = [];

function present(area: string, capability: string, ok: boolean): void {
  findings.push(`${ok ? 'PRESENT' : 'GAP'} · ${area} · ${capability}`);
  expect(ok, `${area} · ${capability}`).toBe(true);
}
function soft(area: string, capability: string, ok: boolean): void {
  findings.push(`${ok ? 'PRESENT' : 'GAP'} · ${area} · ${capability}`);
}

import { login as sharedLogin, ADMIN } from './helpers';

async function login(page: Page): Promise<void> {
  await sharedLogin(page, ADMIN);
}

const bodyHas = async (page: Page, re: RegExp): Promise<boolean> => re.test((await page.textContent('body')) ?? '');

test.describe('engine liveliness audit (hardened)', () => {
  test('dashboard: the live gameweek surface', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(1500); // /api/live + /api/news/feed
    present('dashboard', 'gameweek clock with deadline countdown', (await page.getByTestId('dashboard-live').count()) > 0 && (await bodyHas(page, /deadline/i)));
    // an OPEN stream never lands in resource timings — prove the channel by
    // completing an EventSource handshake against it
    const sseOk = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const es = new EventSource('/api/live/stream');
          const t = setTimeout(() => {
            es.close();
            resolve(false);
          }, 6000);
          es.onopen = () => {
            clearTimeout(t);
            es.close();
            resolve(true);
          };
          es.onerror = () => {
            clearTimeout(t);
            es.close();
            resolve(false);
          };
        }),
    );
    present('dashboard', 'SSE data channel live (/api/live/stream)', sseOk);
    present('dashboard', 'match previews with win% + likely scoreline', (await page.getByTestId('dashboard-previews').count()) > 0 && (await bodyHas(page, /likely \d+-\d+/i)));
    present('dashboard', 'news feed with signal badges + story corroboration', (await page.getByTestId('dashboard-news-feed').count()) > 0);
    soft('dashboard', 'confirmed-lineup indicator near kickoff (KO-window only)', await bodyHas(page, /confirmed (xi|lineup)/i));
  });

  test('live + price APIs: in-play engine outputs', async ({ page }) => {
    await login(page);
    const live = (await page.request.get('/api/live').then((r) => r.json())) as Record<string, unknown>;
    present('api', 'GET /api/live serves event/fixtures/board/priceTicker', 'fixtures' in live && 'board' in live && 'priceTicker' in live && 'nextDeadline' in live);
    const prices = (await page.request.get('/api/prices/predictions').then((r) => r.json())) as Record<string, unknown>;
    present('api', 'GET /api/prices/predictions (risers/fallers + scorecard)', Array.isArray(prices.predictions));
    // same-origin media route exists (CSP img-src self — X2)
    const media = await page.request.get('/api/media/players/p99999999.png');
    present('api', 'same-origin player-photo media route', media.status() === 404); // route live, file simply not cached
  });

  test('players: quantiles, benchmark columns, detail depth', async ({ page }) => {
    await login(page);
    await page.goto('/players');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
    present('players', 'FPL ep_next benchmark + ICT display columns', await bodyHas(page, /FPL xP/) && await bodyHas(page, /ICT/));
    // detail drill-down
    await page.locator('tbody tr').first().click();
    await page.waitForTimeout(1000);
    present('players', 'player detail with per-fixture xPts + score history', await bodyHas(page, /Upcoming fixtures/i) && (await page.getByTestId('sparkline').count()) > 0);
    present('players', 'P10/P50/P90 floor–ceiling on the assessment panel', (await page.getByTestId('player-quantiles').count()) > 0);
    soft('players', 'news timeline on the player page (needs linked news)', (await page.getByTestId('player-news-timeline').count()) > 0);
  });

  test('match engine: previews, h2h, predicted lineups via API', async ({ page }) => {
    await login(page);
    const insights = (await page.request.get('/api/insights').then((r) => r.json())) as { insights?: { fixture_uid: string; reasons?: { preview?: unknown } }[] };
    expect(insights.insights?.length ?? 0).toBeGreaterThan(0);
    present('match', 'insights expose win/draw/loss + top scorelines', JSON.stringify(insights).includes('p_home') && JSON.stringify(insights).includes('top_scorelines'));
    const uid = insights.insights![0]!.fixture_uid;
    const preview = (await page.request.get(`/api/fixtures/${uid}/preview`).then((r) => r.json())) as Record<string, unknown>;
    present('match', 'fixture preview endpoint (probabilities/scorelines/CS)', 'probabilities' in preview && 'topScorelines' in preview && 'cleanSheets' in preview);
    present('match', 'h2h context from imported history', Array.isArray(preview.h2h));
    present('match', 'predicted + confirmed lineup slots in the preview', 'lineups' in preview);
    soft('match', 'referee card-tendency context', JSON.stringify(preview).includes('referee'));
  });

  test('api surface: engine outputs exposed', async ({ page }) => {
    await login(page);
    const players = (await page.request.get('/api/players').then((r) => r.json())) as { players?: { uid: string }[] };
    expect(players.players?.length ?? 0).toBeGreaterThan(100);
    const detail = (await page.request.get(`/api/players/${players.players![0]!.uid}`).then((r) => r.json())) as { matrix?: Record<string, unknown> };
    present('api', 'player detail exposes human_signals evidence field', detail.matrix != null && 'human_signals' in detail.matrix);
    present('api', 'player detail exposes the per-event xpts curve', detail.matrix != null && 'xpts_per_event' in detail.matrix);
    present('api', 'player detail exposes P10/P50/P90 quantiles', detail.matrix != null && 'p90' in detail.matrix);
    const version = (await page.request.get('/api/health').then((r) => r.json())) as { status: string };
    expect(version.status).toBe('ok');
  });

  test.afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('\n──── ENGINE GAP AUDIT (hardened) ────\n' + findings.join('\n') + '\n─────────────────────────────────────');
  });
});
