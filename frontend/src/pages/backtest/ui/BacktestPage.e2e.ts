import { expect, test } from '@playwright/test';

test('the owner can check historical data without saving settings or selecting an account', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked history check.');
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
      case '/api/backtest/history': {
        const parameters = request.postDataJSON();
        expect(parameters).toEqual({
          instrumentUid: 'future', timeframe: '1h', emaPeriod: 55, lots: 3, from: '2026-11-18', to: '2026-11-19',
        });
        if (++requests === 2) return route.fulfill({ status: 422, json: { code: 'BACKTEST_EMA_MISSING' } });
        return route.fulfill({ json: {
          parameters, cutoff: Date.UTC(2026, 10, 19, 12), candles: [{
            time: Date.UTC(2026, 10, 18, 12), open: 101, high: 104, low: 100, close: 103, complete: true, ema: 102,
          }],
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
  await expect(page.getByText(/Лимит проверки: 7 календарных дней/)).toBeVisible();
  await page.getByLabel('Поиск фьючерса').fill('IMOEXF');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByLabel('Контракт').selectOption('future');
  await page.getByLabel('Период EMA').fill('55');
  await page.getByLabel('Объём, лотов').fill('3');
  await page.getByLabel('С даты').fill('2026-11-18');
  await page.getByLabel('По дату').fill('2026-11-19');
  expect(requests).toBe(0);
  const check = page.getByRole('button', { name: 'Проверить данные' });
  await check.click();
  await expect(page.getByRole('img', { name: 'График исторических свечей и EMA' }).locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/Последний день ещё не закончился: проверка до .*15:00 МСК/)).toBeVisible();
  await check.click();
  await expect(page.getByText(/Брокер не вернул EMA/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'График исторических свечей и EMA' })).toHaveCount(0);
});
