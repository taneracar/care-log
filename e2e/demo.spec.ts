import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const DIST = join(__dirname, '..', 'dist');
let errors: string[];

// The exported build is served straight from disk by request interception: no server needed.
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('http://demo.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    try {
      const contentType = /\.js$/.test(file) ? 'text/javascript' : /\.html$/.test(file) ? 'text/html' : undefined;
      await route.fulfill({ body: await readFile(file), contentType });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://demo.test/');
  await expect(phone(page, 'Ben').getByText('Feed · 120 ml')).toBeVisible();
});
test.afterEach(() => expect(errors).toEqual([]));

const phone = (page: Page, owner: string) => page.getByRole('region', { name: `${owner}'s phone` });

async function conflict(page: Page) {
  for (const [owner, button] of [['Ada', /more/], ['Ben', /less/]] as const) {
    await page.getByRole('button', { name: `Take offline: ${owner}` }).click();
    const p = phone(page, owner);
    await p.getByRole('button', { name: /^Feed · 120/ }).click();
    await p.getByRole('button', { name: button }).click();
    await p.getByRole('button', { name: 'Done' }).click();
    await expect(p.getByText('Offline · 1 waiting')).toBeVisible();
  }
  for (const owner of ['Ada', 'Ben']) await page.getByRole('button', { name: `Reconnect: ${owner}` }).click();
  for (const owner of ['Ada', 'Ben']) {
    await expect(phone(page, owner).getByText('Two versions, pick one')).toBeVisible();
  }
}

test('an entry made on one phone shows up on the other', async ({ page }) => {
  await phone(page, 'Ada').getByRole('button', { name: 'Diaper', exact: true }).click();
  await phone(page, 'Ada').getByRole('button', { name: 'Dirty', exact: true }).click();
  await phone(page, 'Ada').getByRole('button', { name: 'Done' }).click();
  await expect(phone(page, 'Ben').getByText('Diaper · Dirty')).toBeVisible();
  await expect(phone(page, 'Ada').getByText('Synced')).toBeVisible();
});

test('offline edits to one field conflict, and one answer settles both phones', async ({ page }) => {
  await conflict(page);
  const ben = phone(page, 'Ben');
  await ben.getByRole('button', { name: /Two versions/ }).click();
  await ben.getByRole('button', { name: /^130 ml \(other phone\)/ }).click();
  await ben.getByRole('button', { name: 'Done' }).click();
  for (const owner of ['Ada', 'Ben']) {
    await expect(phone(page, owner).getByText('Feed · 130 ml')).toBeVisible();
    await expect(phone(page, owner).getByText('Two versions, pick one')).toBeHidden();
  }
});

test('typing a note works while the other phone syncs', async ({ page }) => {
  const ada = phone(page, 'Ada');
  await ada.getByRole('button', { name: /^Feed · 120/ }).click();
  await ada.getByLabel('Note').fill('half');
  await phone(page, 'Ben').getByRole('button', { name: 'Asleep' }).click();
  await expect(phone(page, 'Ben').getByText('Synced')).toBeVisible();
  await expect(ada.getByLabel('Note')).toHaveValue('half');
  await ada.getByRole('button', { name: 'Done' }).click();
  await expect(phone(page, 'Ben').getByText('half')).toBeVisible();
});

test('no WCAG A/AA violations, and no sideways scroll', async ({ page }, info) => {
  const scan = async (name: string) => {
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-${name}.png`, fullPage: true });
  };
  await scan('list');
  await conflict(page);
  await scan('conflict');
  await phone(page, 'Ada').getByRole('button', { name: /Two versions/ }).click();
  await scan('editor');
});
