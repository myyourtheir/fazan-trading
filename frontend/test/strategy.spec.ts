import { expect, test } from '@playwright/test';

test('strategy starts with IMOEXF and EMA55, requires an explicit contract, and restores saved values', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked futures catalogue.');
  const contracts = [
    { uid: 'continuous-uid', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
      exchange: 'MOEX', expirationDate: null },
    { uid: 'quarterly-uid', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
      exchange: 'MOEX', expirationDate: '2027-03-18T00:00:00.000Z' },
  ];
  let saved: { instrument: (typeof contracts)[number]; emaPeriod: number; lots: number } | null = null;
  let available = true;
  let catalogue = contracts;
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped' } });
      case '/api/sandbox':
        return route.fulfill({ json: available
          ? { status: 'connected', accountId: 'sandbox-1', accounts: [{ id: 'sandbox-1', name: 'Песочница' }],
              virtualFundingRubles: 100_000 }
          : { status: 'unavailable', accountId: 'sandbox-1', accounts: [], code: 'SANDBOX_UNREACHABLE' } });
      case '/api/strategy/futures':
        return route.fulfill({ json: ['IMOEXF', 'Мосбиржи'].includes(url.searchParams.get('q') ?? '') ? catalogue : [] });
      case '/api/strategy':
        if (request.method() === 'GET') {
          return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55 }, settings: saved } });
        }
        expect(request.postDataJSON()).toEqual({
          accountId: 'sandbox-1', instrumentUid: 'quarterly-uid', emaPeriod: 34, lots: 3,
        });
        saved = { instrument: contracts[1], emaPeriod: 34, lots: 3 };
        return route.fulfill({ status: 204 });
      default:
        return route.fulfill({ status: 404 });
    }
  });

  await page.goto('/');
  const strategy = page.getByRole('region', { name: 'Настройки стратегии' });
  const search = strategy.getByLabel('Поиск фьючерса');
  const select = strategy.getByLabel('Контракт');
  const period = strategy.getByLabel('Период EMA');
  const lots = strategy.getByLabel('Объём, лотов');
  const save = strategy.getByRole('button', { name: 'Сохранить настройки' });
  await expect(search).toHaveValue('IMOEXF');
  await expect(period).toHaveValue('55');
  await expect(lots).toHaveValue('');
  await expect(select.getByRole('option')).toHaveCount(3);
  await expect(select.getByRole('option', { name: /18\.03\.2027.*quarterly-uid/ })).toHaveCount(1);
  await lots.fill('3');
  await expect(save).toBeDisabled();
  await search.fill('Мосбиржи');
  const searchRequest = page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'Мосбиржи');
  await search.press('Enter');
  await searchRequest;
  await expect(select.getByRole('option')).toHaveCount(3);
  await select.selectOption('quarterly-uid');
  await period.fill('34');
  await save.click();
  await expect(strategy.getByText('Настройки сохранены.')).toBeVisible();

  await page.reload();
  await expect(select).toHaveValue('quarterly-uid');
  await expect(period).toHaveValue('34');
  await expect(lots).toHaveValue('3');

  catalogue = [contracts[0]];
  await page.reload();
  await expect(select.getByRole('option')).toHaveCount(2);
  await expect(select).toHaveValue('');
  await expect(strategy.getByText(/Выбран контракт:.*quarterly-uid/)).toBeVisible();
  await expect(save).toBeDisabled();

  available = false;
  await page.reload();
  await expect(strategy.getByText(/Выбран контракт:.*quarterly-uid/)).toBeVisible();
  await expect(period).toHaveValue('34');
  await expect(lots).toHaveValue('3');
  await expect(save).toBeDisabled();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
