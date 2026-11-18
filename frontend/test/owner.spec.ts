import { expect, test } from '@playwright/test';

test('the owner can enter and leave the protected dashboard', async ({ page }) => {
  const target = process.env.SERFING_E2E_URL;
  const password = target ? process.env.SERFING_E2E_PASSWORD : 'local-browser-test-password';
  if (!password) throw new Error('Set SERFING_E2E_PASSWORD when testing a running deployment.');

  if (!target) {
    let signedIn = false;
    await page.route('**/api/**', route => {
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
      return route.fulfill({ json: path.endsWith('/dashboard')
        ? { mode: 'stopped' } : { authenticated: true, remainingMs: 60_000 } });
    });
  } else {
    expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  }

  await page.goto('/');
  const login = page.getByRole('heading', { name: 'Вход в «Сёрфинг»' });
  const dashboard = page.getByRole('heading', { name: 'Панель робота' });
  await expect(login).toBeVisible();
  await expect(dashboard).toHaveCount(0);

  const field = page.getByLabel('Пароль');
  await field.fill(password === 'wrong-owner-password' ? 'different-owner-password' : 'wrong-owner-password');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный пароль.');
  await expect(dashboard).toHaveCount(0);

  await field.fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(dashboard).toBeVisible();
  await expect(page.getByText('Робот остановлен')).toBeVisible();
  await page.reload();
  await expect(dashboard).toBeVisible();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(login).toBeVisible();
  await expect(dashboard).toHaveCount(0);
  if (target) expect((await page.request.get('/api/dashboard')).status()).toBe(401);
});

test('the protected panel closes when a session expires in a focused tab', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a short-lived mocked session.');
  await page.clock.install();
  let expired = false;
  await page.route('**/api/**', route => {
    if (expired) return route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } });
    const dashboard = new URL(route.request().url()).pathname.endsWith('/dashboard');
    return route.fulfill({ json: dashboard ? { mode: 'stopped' } : { authenticated: true, remainingMs: 5_000 } });
  });
  await page.goto('/');
  const dashboard = page.getByRole('heading', { name: 'Панель робота' });
  await expect(dashboard).toBeVisible();
  expired = true;
  await page.clock.fastForward(6_000);
  await expect(page.getByRole('heading', { name: 'Вход в «Сёрфинг»' })).toBeVisible();
  await expect(dashboard).toHaveCount(0);
});
