import { expect, test } from '@playwright/test';

test('the owner can run a backtest without saving settings or selecting an account', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  let signedIn = false;
  let requests = 0;
  await page.route('/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill(signedIn
          ? { json: { authenticated: true, remainingMs: 60_000 } }
          : { status: 401, json: { code: 'UNAUTHENTICATED' } });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxDays: 7, maxEmaPeriod: 1000 } });
      case '/api/strategy/futures':
        expect(url.searchParams.get('q')).toBe('IMOEXF');
        return route.fulfill({ json: [{
          uid: 'future', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
          exchange: 'MOEX', expirationDate: null,
        }] });
      case '/api/backtest/run': {
        const parameters = request.postDataJSON();
        expect(parameters).toEqual({
          instrumentUid: 'future', timeframe: '1h', emaPeriod: 55, lots: 3, from: '2026-11-18', to: '2026-11-19',
        });
        if (++requests === 2) return route.fulfill({ status: 422, json: { code: 'BACKTEST_EMA_MISSING' } });
        return route.fulfill({ json: {
          parameters, currency: 'rub', pointValue: 10, priceStep: 0.5, priceStepAmount: 5, lot: 1,
          candles: [{
            time: Date.UTC(2026, 10, 18, 12), open: 101, high: 104, low: 100, close: 103, complete: true, ema: 102,
          }, {
            time: Date.UTC(2026, 10, 18, 13), open: 103, high: 106, low: 102, close: 105, complete: true, ema: 102,
          }],
          executions: [{ time: Date.UTC(2026, 10, 18, 13), direction: 'buy', lots: 3, price: 103 }],
          finalSignal: null,
          result: { closed: 0, open: 60, total: 60, position: 3 },
          cutoff: null,
        } });
      }
      default:
        throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
    }
  });

  await page.goto('/backtest');
  await expect(page).toHaveURL(/\/login$/);
  signedIn = true;
  await page.goto('/backtest');
  await expect(page.getByRole('heading', { name: 'Бэктест' })).toBeVisible();
  await expect(page.getByText(/Лимит прогона: 7 календарных дней/)).toBeVisible();
  await page.getByLabel('Поиск фьючерса').fill('IMOEXF');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByLabel('Контракт').selectOption('future');
  await page.getByLabel('Период EMA').fill('55');
  await page.getByLabel('Объём, лотов').fill('3');
  await page.getByLabel('С даты').fill('2026-11-18');
  await page.getByLabel('По дату').fill('2026-11-19');
  expect(requests).toBe(0);
  const run = page.getByRole('button', { name: 'Запустить бэктест' });
  await run.click();
  await expect(page.getByRole('heading', { name: 'Отчёт по стратегии' })).toBeVisible();
  await expect(page.getByText(/Комиссия и проскальзывание не учитываются/)).toBeVisible();
  await expect(page.getByText('Покупка')).toBeVisible();
  await expect(page.getByRole('img', { name: 'График исторических свечей и EMA' }).locator('canvas').first()).toBeVisible();
  await run.click();
  await expect(page.getByText(/Брокер не вернул EMA/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Отчёт по стратегии' })).toHaveCount(0);
});
