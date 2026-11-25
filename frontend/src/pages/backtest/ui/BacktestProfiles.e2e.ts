import { expect, test } from '@playwright/test';

const improved = {
  emaPeriod: 34,
  atrPeriod: 10,
  stopAtrMultiplier: 2.5,
  addStepAtr: 1.5,
  maxAddOns: 2,
  tradeWeekends: true,
};
const contract = {
  uid: 'future',
  ticker: 'IMOEXF',
  name: 'Индекс Мосбиржи',
  classCode: 'SPBFUT',
  exchange: 'MOEX',
  expirationDate: null,
};

test('dashboard and direct entry use saved profiles, and switching only changes the simulation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  await page.clock.install({ time: '2026-11-20T12:00:00Z' });
  const mutations: string[] = [];
  const runs: unknown[] = [];
  await page.route('/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path !== '/api/backtest/run') {
      mutations.push(path);
      return route.fulfill({ status: 400 });
    }
    switch (path) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/settings/display':
        return route.fulfill({ json: { timeZone: 'UTC' } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/sandbox':
        return route.fulfill({
          json: {
            status: 'connected',
            accountId: 'sandbox-1',
            accounts: [{ id: 'sandbox-1', name: 'Песочница' }],
            virtualFundingRubles: 100_000,
          },
        });
      case '/api/strategy/profiles':
        return route.fulfill({
          json: {
            selected: 'improved-surfing',
            legacyClaimAvailable: false,
            profiles: {
              surfing: {
                defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' },
                settings: {
                  instrument: contract,
                  timeframe: '1h',
                  parameters: { emaPeriod: 44, lots: 3 },
                },
              },
              'improved-surfing': {
                defaults: { ticker: 'IMOEXF', timeframe: '1h', ...improved },
                settings: { instrument: contract, timeframe: '30m', parameters: improved },
              },
            },
          },
        });
      case '/api/strategy/futures':
        return route.fulfill({ json: [contract] });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxEmaPeriod: 1000 } });
      case '/api/backtest/run':
        runs.push(request.postDataJSON());
        return route.fulfill({ status: 422, json: { code: 'BACKTEST_NO_CONFIRMED_INTERVALS' } });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  await page.routeWebSocket('**/api/market/live', (socket) =>
    socket.send(JSON.stringify({ stream: 'live' })),
  );
  await page.routeWebSocket('**/api/robot/live', () => {});

  await page.goto('/');
  const dashboard = page.getByRole('region', { name: 'Настройки стратегии' });
  await dashboard.getByLabel('Период EMA').fill('90');
  await dashboard.getByRole('button', { name: 'Бэктест' }).click();
  await expect(page).toHaveURL(/\/backtest$/);
  const kind = page.getByLabel('Стратегия', { exact: true });
  await expect(kind).toHaveValue('improved-surfing');
  await expect(page.getByLabel('Таймфрейм')).toHaveValue('30m');
  await expect(page.getByLabel('Период EMA')).toHaveValue('34');
  await expect(page.getByLabel('Период ATR')).toHaveValue('10');
  await expect(page.getByLabel('Торговать по выходным')).toBeChecked();
  await expect(page.getByLabel('Начальные свободные деньги, ₽')).toHaveValue('100000');

  const range = page.getByLabel('Диапазон дат');
  await range.click();
  await page.getByRole('button', { name: /18/ }).click();
  await page.getByRole('button', { name: /19/ }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('Комиссия, %').fill('0.1');
  await page.getByLabel('Проскальзывание, шагов цены').fill('2');
  await page.getByLabel('Период ATR').fill('12');
  await page.getByRole('button', { name: 'Запустить бэктест' }).click();
  await expect(
    page.getByText(/нет свечей стратегии, подтверждённых минутными свечами/),
  ).toBeVisible();
  expect(runs[0]).toEqual({
    ...improved,
    atrPeriod: 12,
    kind: 'improved-surfing',
    instrumentUid: 'future',
    timeframe: '30m',
    from: '2026-11-18',
    to: '2026-11-19',
    commission: 0.1,
    slippage: 2,
    initialMoney: 100000,
  });

  await kind.selectOption('surfing');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('3');
  await expect(page.getByLabel('Период EMA')).toHaveValue('44');
  await expect(range).toHaveText('18.11.2026 — 19.11.2026');
  await expect(page.getByLabel('Комиссия, %')).toHaveValue('0.1');
  await expect(page.getByLabel('Проскальзывание, шагов цены')).toHaveValue('2');
  await page.reload();
  await expect(kind).toHaveValue('improved-surfing');
  await expect(page.getByLabel('Период ATR')).toHaveValue('10');
  expect(mutations).toEqual([]);
});
