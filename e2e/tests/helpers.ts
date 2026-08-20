import { type Page, expect } from '@playwright/test';

export const ADMIN = { email: 'admin@fpl.test', password: 'admin-password-123' };
export const USER = { email: 'user@fpl.test', password: 'user-password-1234' };

export async function login(page: Page, creds: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(creds.email);
  await page.getByTestId('login-password').fill(creds.password);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/$/);
}

/** The §12.2 hard requirement: no horizontal page scroll, ever. */
export async function assertNoHorizontalOverflow(page: Page, label = ''): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    // name the widest offender to make failures actionable
    let worst = { tag: '', cls: '', width: 0 };
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right > worst.width) worst = { tag: el.tagName, cls: (el as HTMLElement).className?.toString?.().slice(0, 60) ?? '', width: Math.round(r.right) };
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, worst };
  });
  expect(
    overflow.scrollWidth,
    `${label || page.url()} overflows horizontally (${overflow.scrollWidth} > ${overflow.clientWidth}); widest: <${overflow.worst.tag} class="${overflow.worst.cls}"> right=${overflow.worst.width}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** 1×1 transparent PNG for the vision-upload flow (mock provider ignores pixels). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
