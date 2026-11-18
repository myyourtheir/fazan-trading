import { expect, test } from '@playwright/test';

test('the owner can check a token and select, create, and fund a sandbox account', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked sandbox API and does not require a broker token.');
  const token = 'mock-sandbox-token';
  let configured = false;
  let accountId: string | null = null;
  const accounts = [{ id: 'existing', name: 'Мой счёт' }];
  await page.route('/api/**', route => {
    const request = route.request();
    switch (new URL(request.url()).pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/robot/history':
        return route.fulfill({ json: [] });
      case '/api/strategy':
        return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55 }, settings: null } });
      case '/api/strategy/futures':
        return route.fulfill({ json: [] });
      case '/api/sandbox':
        return route.fulfill({ json: {
          status: configured ? 'connected' : 'unconfigured', accountId, accounts: configured ? accounts : [],
          virtualFundingRubles: configured ? 100_000 : undefined,
        } });
      case '/api/sandbox/connection':
        if (request.postDataJSON().token !== token) {
          return route.fulfill({ status: 422, json: { code: 'SANDBOX_TOKEN_REJECTED' } });
        }
        configured = true;
        return route.fulfill({ status: 204 });
      case '/api/sandbox/account':
        accountId = request.postDataJSON().accountId;
        return route.fulfill({ status: 204 });
      case '/api/sandbox/accounts':
        accountId = 'created';
        accounts.push({ id: accountId, name: 'Сёрфинг' });
        return route.fulfill({ status: 204 });
      case '/api/sandbox/funding':
        expect(request.postDataJSON().accountId).toBe('created');
        return route.fulfill({ status: 204 });
      default:
        return route.fulfill({ status: 404 });
    }
  });

  await page.routeWebSocket('**/api/robot/live', () => {});
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/');
  await expect(page.getByText('Песочница не подключена.')).toBeVisible();
  const connectionCard = page.getByRole('region', { name: 'Подключение' });
  const accountsCard = page.getByRole('region', { name: 'Виртуальные счета' });
  await expect(accountsCard.getByText('Сначала подключите песочницу')).toBeVisible();
  const connection = (await connectionCard.boundingBox())!;
  const accountsPanel = (await accountsCard.boundingBox())!;
  expect(accountsPanel.y).toBe(connection.y);
  expect(accountsPanel.x).toBeGreaterThan(connection.x + connection.width);
  const input = page.getByLabel('Токен песочницы');
  await expect(input).toHaveAttribute('type', 'password');
  const connect = page.getByRole('button', { name: 'Проверить и сохранить' });
  await input.fill('bad-token');
  await connect.click();
  await expect(connectionCard.getByRole('alert')).toContainText('Песочница отклонила токен.');
  await input.fill(token);
  await connect.click();
  await expect(page.getByText('Песочница подключена.')).toBeVisible();
  await expect(input).toHaveValue('');

  await page.getByLabel('Виртуальный счёт').selectOption('existing');
  await page.getByRole('button', { name: 'Выбрать счёт' }).click();
  await expect(page.getByText('Выбран счёт: existing')).toBeVisible();
  await page.getByRole('button', { name: 'Создать виртуальный счёт' }).click();
  await expect(page.getByText('Выбран счёт: created')).toBeVisible();
  await page.getByRole('button', { name: 'Пополнить на 100 000 ₽' }).click();
  await expect(page.getByText('Виртуальный счёт пополнен на 100 000 ₽.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Выбран счёт: created')).toBeVisible();
  await expect(input).toHaveValue('');

  await page.setViewportSize({ width: 360, height: 800 });
  const mobileConnection = (await connectionCard.boundingBox())!;
  const mobileAccounts = (await accountsCard.boundingBox())!;
  expect(mobileAccounts.x).toBe(mobileConnection.x);
  expect(mobileAccounts.y).toBeGreaterThan(mobileConnection.y + mobileConnection.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
