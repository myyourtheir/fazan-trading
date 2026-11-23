import { expect, test } from '@playwright/test';

const emptyStrategy = { defaults: { ticker: 'IMOEXF', emaPeriod: 55 }, settings: null };

test('the app header stays visible while the page scrolls', async ({ page }) => {
  test.skip(
    Boolean(process.env.SERFING_E2E_URL),
    'Creates deterministic overflow in the local browser.',
  );
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401 }));
  await page.goto('/login');

  const header = page.getByRole('banner');
  const main = page.locator('main');
  const theme = header.getByRole('button');
  await expect(header).toBeVisible();
  await expect(theme).toBeVisible();
  const headerBefore = (await header.boundingBox())!;
  const mainBefore = (await main.boundingBox())!;
  expect(mainBefore.y).toBeGreaterThanOrEqual(headerBefore.y + headerBefore.height);

  await page.evaluate(() => {
    const overflow = document.createElement('div');
    overflow.textContent = 'Конец прокручиваемого содержимого';
    overflow.style.height = `${window.innerHeight * 3}px`;
    document.querySelector('main')!.append(overflow);
  });
  const contentBefore = (await page.getByText('Конец прокручиваемого содержимого').boundingBox())!;
  await page.evaluate(() => window.scrollTo({ top: 400 }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);

  const headerAfter = (await header.boundingBox())!;
  const contentAfter = (await page.getByText('Конец прокручиваемого содержимого').boundingBox())!;
  expect(headerAfter.y).toBe(headerBefore.y);
  expect(contentAfter.y).toBeLessThan(contentBefore.y);
  const darkBefore = await page
    .locator('html')
    .evaluate((element) => element.classList.contains('dark'));
  await theme.click();
  expect(await page.locator('html').evaluate((element) => element.classList.contains('dark'))).toBe(
    !darkBefore,
  );
});

test('the owner can enter and leave the protected dashboard', async ({ page }) => {
  const target = process.env.SERFING_E2E_URL;
  const password = target ? process.env.SERFING_E2E_PASSWORD : 'local-browser-test-password';
  if (!password) throw new Error('Set SERFING_E2E_PASSWORD when testing a running deployment.');

  if (!target) {
    let signedIn = false;
    await page.route('/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/login') {
        if (route.request().postDataJSON().password !== password) {
          return route.fulfill({ status: 401, json: { code: 'INVALID_CREDENTIALS' } });
        }
        signedIn = true;
        return route.fulfill({ json: { authenticated: true } });
      }
      if (path === '/api/auth/logout') {
        signedIn = false;
        return route.fulfill({ status: 204 });
      }
      if (!signedIn) return route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } });
      if (path === '/api/robot/history') return route.fulfill({ json: [] });
      if (path === '/api/strategy/profiles')
        return route.fulfill({
          json: {
            selected: 'surfing',
            legacyClaimAvailable: false,
            profiles: {
              surfing: emptyStrategy,
              'improved-surfing': { defaults: {}, settings: null },
            },
          },
        });
      if (path.endsWith('/sandbox'))
        return route.fulfill({ json: { status: 'unconfigured', accountId: null, accounts: [] } });
      if (path === '/api/strategy') return route.fulfill({ json: emptyStrategy });
      return route.fulfill({
        json: path.endsWith('/dashboard')
          ? { mode: 'stopped', reason: null, position: null }
          : { authenticated: true, remainingMs: 60_000 },
      });
    });
    await page.routeWebSocket('**/api/robot/live', () => {});
  } else {
    expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  }

  await page.goto('/');
  const login = page.getByRole('heading', { name: 'Вход в fazan-trading' });
  const dashboard = page.getByRole('heading', { name: 'Панель робота' });
  await expect(login).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(dashboard).toHaveCount(0);
  const historyLength = await page.evaluate(() => window.history.length);

  const field = page.getByLabel('Пароль');
  await field.fill(
    password === 'wrong-owner-password' ? 'different-owner-password' : 'wrong-owner-password',
  );
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный пароль.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('Неверный пароль.');
  await expect(dashboard).toHaveCount(0);

  await field.fill(password);
  await field.press('Enter');
  await expect(dashboard).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.getByText('Робот остановлен')).toBeVisible();
  await page.reload();
  await expect(dashboard).toBeVisible();
  await page.getByRole('button', { name: 'Профиль' }).press('Enter');
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(login).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(dashboard).toHaveCount(0);
  if (target) expect((await page.request.get('/api/dashboard')).status()).toBe(401);
});

test('the protected panel closes when a session expires in a focused tab', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a short-lived mocked session.');
  await page.clock.install();
  let expired = false;
  await page.route('/api/**', (route) => {
    if (expired) return route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } });
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/robot/history') return route.fulfill({ json: [] });
    if (path === '/api/strategy/profiles')
      return route.fulfill({
        json: {
          selected: 'surfing',
          legacyClaimAvailable: false,
          profiles: {
            surfing: emptyStrategy,
            'improved-surfing': { defaults: {}, settings: null },
          },
        },
      });
    if (path.endsWith('/sandbox')) {
      return route.fulfill({ json: { status: 'unconfigured', accountId: null, accounts: [] } });
    }
    if (path === '/api/strategy') return route.fulfill({ json: emptyStrategy });
    const dashboard = path.endsWith('/dashboard');
    return route.fulfill({
      json: dashboard
        ? { mode: 'stopped', reason: null, position: null }
        : { authenticated: true, remainingMs: 5_000 },
    });
  });
  await page.routeWebSocket('**/api/robot/live', () => {});
  await page.goto('/');
  const dashboard = page.getByRole('heading', { name: 'Панель робота' });
  await expect(dashboard).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  expired = true;
  await page.clock.fastForward(6_000);
  await expect(page.getByRole('heading', { name: 'Вход в fazan-trading' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(dashboard).toHaveCount(0);
});

for (const route of ['/dashboard', '/settings']) {
  test(`opening ${route} without a session redirects before requesting protected data`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.SERFING_E2E_URL), 'Checks requests with a mocked session.');
    const paths: string[] = [];
    await page.route('/api/**', (request) => {
      paths.push(new URL(request.request().url()).pathname);
      return request.fulfill({ status: 401 });
    });

    await page.goto(route);
    await expect(page.getByRole('heading', { name: 'Вход в fazan-trading' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(paths).toEqual(['/api/auth/session']);
  });
}

test('opening the login route with a session redirects to the dashboard', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses an authenticated mocked session.');
  await page.route('/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/sandbox':
        return route.fulfill({ json: { status: 'unconfigured', accountId: null, accounts: [] } });
      case '/api/strategy':
        return route.fulfill({ json: emptyStrategy });
      case '/api/robot/history':
        return route.fulfill({ json: [] });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  await page.routeWebSocket('**/api/robot/live', () => {});

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Панель робота' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Вход в fazan-trading' })).toHaveCount(0);
});

test('a session check failure stays on the requested route until retry resolves it', async ({
  page,
}) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Simulates a temporary server failure.');
  let available = false;
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ status: available ? 401 : 503 }),
  );

  await page.goto('/dashboard');
  await expect(page.getByRole('alert')).toHaveText('Сервер недоступен.');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading')).toHaveCount(0);

  const failedRetry = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/session') && response.status() === 503,
  );
  await page.getByRole('button', { name: 'Повторить' }).click();
  await failedRetry;
  await expect(page.getByRole('alert')).toHaveText('Сервер недоступен.');
  await expect(page).toHaveURL(/\/dashboard$/);

  available = true;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('heading', { name: 'Вход в fazan-trading' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('switching themes changes the rendered Tailwind colors', async ({ page }) => {
  test.skip(
    Boolean(process.env.SERFING_E2E_URL),
    'Checks the front-end theme without signing into a deployment.',
  );
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401 }));
  await page.goto('/');
  const submit = page.getByRole('button', { name: 'Войти' });
  await expect(submit).toHaveCSS('background-color', 'rgb(120, 224, 206)');
  await page.getByRole('button', { name: 'Светлая тема' }).click();
  await expect(submit).toHaveCSS('background-color', 'rgb(8, 99, 91)');
});
