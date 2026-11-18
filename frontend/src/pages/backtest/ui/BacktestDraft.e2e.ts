import { expect, test, type WebSocketRoute } from '@playwright/test';

const contract = {
  uid: 'future', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
  exchange: 'MOEX', expirationDate: null,
};

test('the strategy draft opens the backtest without saving and carries unsaved edits', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  // Pin the clock so the range calendar always opens on the month the scenario picks.
  await page.clock.install({ time: '2026-11-18T12:00:00Z' });
  let saved = false;
  let run = 0;
  await page.route('/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/sandbox':
        return route.fulfill({ json: { status: 'connected', accountId: 'sandbox-1',
          accounts: [{ id: 'sandbox-1', name: 'Песочница' }], virtualFundingRubles: 100_000 } });
      case '/api/market':
        return route.fulfill({ json: null });
      case '/api/strategy':
        if (request.method() === 'GET') {
          return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' }, settings: null } });
        }
        saved = true;
        throw new Error('The backtest hand-off must not save the strategy.');
      case '/api/strategy/futures':
        return route.fulfill({ json: ['IMOEXF'].includes(url.searchParams.get('q') ?? '') ? [contract] : [] });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxDays: 30, maxEmaPeriod: 1000 } });
      case '/api/backtest/run': {
        const parameters = request.postDataJSON();
        expect(parameters).toEqual({
          instrumentUid: 'future', timeframe: '15m', emaPeriod: 55, lots: 4, from: '2026-11-18', to: '2026-11-19',
          commission: 0, slippage: 0,
        });
        run += 1;
        return route.fulfill({ json: {
          parameters, currency: 'rub', pointValue: 10, priceStep: 0.5, priceStepAmount: 5, lot: 1,
          candles: [], executions: [], finalSignal: null,
          result: { closed: 0, open: 0, total: 0, position: 0, maxDrawdown: 0 },
          cutoff: null,
        } });
      }
      default:
        return route.fulfill({ status: 404 });
    }
  });
  await page.routeWebSocket('**/api/market/live', socket => socket.send(JSON.stringify({ stream: 'live' })));
  await page.routeWebSocket('**/api/robot/live', () => {});

  await page.goto('/');
  const strategy = page.getByRole('region', { name: 'Настройки стратегии' });
  await strategy.getByLabel('Контракт').selectOption('future');
  await strategy.getByLabel('Таймфрейм').selectOption('15m');
  await strategy.getByLabel('Объём, лотов').fill('4');
  await strategy.getByRole('button', { name: 'Бэктест' }).click();

  await expect(page).toHaveURL(/\/backtest$/);
  expect(saved).toBe(false);
  await expect(page.getByLabel('Контракт')).toHaveValue('future');
  await expect(page.getByLabel('Таймфрейм')).toHaveValue('15m');
  await expect(page.getByLabel('Период EMA')).toHaveValue('55');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('4');

  await page.getByLabel('Диапазон дат').click();
  await page.getByRole('button', { name: /18/ }).click();
  await page.getByRole('button', { name: /19/ }).click();
  await page.getByRole('button', { name: 'Запустить бэктест' }).click();
  await expect(page.getByRole('heading', { name: 'Отчёт по стратегии' })).toBeVisible();
  expect(run).toBe(1);

  // Editing a significant parameter marks the still-visible report as stale.
  await page.getByLabel('Объём, лотов').fill('5');
  await expect(page.getByText('Параметры изменены')).toBeVisible();
});

test('direct entry to the backtest restores the last saved parameters', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  await page.route('/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/strategy':
        return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' },
          settings: { instrument: contract, emaPeriod: 34, lots: 3, timeframe: '30m' } } });
      case '/api/strategy/futures':
        return route.fulfill({ json: ['IMOEXF'].includes(url.searchParams.get('q') ?? '') ? [contract] : [] });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxDays: 30, maxEmaPeriod: 1000 } });
      default:
        return route.fulfill({ status: 404 });
    }
  });

  await page.goto('/backtest');
  await expect(page.getByRole('heading', { name: 'Бэктест' })).toBeVisible();
  await expect(page.getByLabel('Контракт')).toHaveValue('future');
  await expect(page.getByLabel('Таймфрейм')).toHaveValue('30m');
  await expect(page.getByLabel('Период EMA')).toHaveValue('34');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('3');
});

test('a refresh after opening from a draft restores the saved parameters, not the draft', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  await page.route('/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/sandbox':
        return route.fulfill({ json: { status: 'connected', accountId: 'sandbox-1',
          accounts: [{ id: 'sandbox-1', name: 'Песочница' }], virtualFundingRubles: 100_000 } });
      case '/api/market':
        return route.fulfill({ json: null });
      case '/api/strategy':
        return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' },
          settings: { instrument: contract, emaPeriod: 34, lots: 3, timeframe: '30m' } } });
      case '/api/strategy/futures':
        return route.fulfill({ json: ['IMOEXF'].includes(url.searchParams.get('q') ?? '') ? [contract] : [] });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxDays: 30, maxEmaPeriod: 1000 } });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  await page.routeWebSocket('**/api/market/live', socket => socket.send(JSON.stringify({ stream: 'live' })));
  await page.routeWebSocket('**/api/robot/live', () => {});

  await page.goto('/');
  const strategy = page.getByRole('region', { name: 'Настройки стратегии' });
  await strategy.getByLabel('Контракт').selectOption('future');
  await strategy.getByLabel('Таймфрейм').selectOption('15m');
  await strategy.getByLabel('Объём, лотов').fill('4');
  await strategy.getByRole('button', { name: 'Бэктест' }).click();
  await expect(page).toHaveURL(/\/backtest$/);
  await expect(page.getByLabel('Таймфрейм')).toHaveValue('15m');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('4');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Бэктест' })).toBeVisible();
  await expect(page.getByLabel('Таймфрейм')).toHaveValue('30m');
  await expect(page.getByLabel('Период EMA')).toHaveValue('34');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('3');
});
