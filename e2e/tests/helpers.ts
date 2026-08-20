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
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  expect(overflow.scrollWidth, `page overflows horizontally (${overflow.scrollWidth} > ${overflow.clientWidth})`).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

/** 1×1 transparent PNG for the vision-upload flow (mock provider ignores pixels). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
