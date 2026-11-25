import { expect, test } from '@playwright/test';

test.use({ timezoneId: 'Asia/Tokyo' });

test('the owner can run a backtest without saving settings or selecting an account', async ({
  page,
}) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  // December in the browser, but November in Moscow.
  await page.clock.install({ time: '2026-11-30T20:30:00Z' });
  await page.addInitScript(() => {
    // Chart ticks are drawn on canvas rather than exposed as DOM text.
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^\d{2}:\d{2}$/.test(text)) this.canvas.dataset.clockTick = text;
      if (maxWidth === undefined) fillText.call(this, text, x, y);
      else fillText.call(this, text, x, y, maxWidth);
    };
  });
  let signedIn = false;
  let requests = 0;
  await page.route('/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill(
          signedIn
            ? { json: { authenticated: true, remainingMs: 60_000 } }
            : { status: 401, json: { code: 'UNAUTHENTICATED' } },
        );
      case '/api/settings/display':
        return route.fulfill({ json: { timeZone: 'America/New_York' } });
      case '/api/backtest/limits':
        return route.fulfill({ json: { maxDays: 30, maxEmaPeriod: 1000 } });
      case '/api/strategy/profiles':
        expect(request.method()).toBe('GET');
        return route.fulfill({
          json: {
            selected: 'surfing',
            legacyClaimAvailable: false,
            profiles: {
              surfing: {
                defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' },
                settings: null,
              },
              'improved-surfing': {
                defaults: {
                  atrPeriod: 20,
                  stopAtrMultiplier: 2,
                  addStepAtr: 1,
                  maxAddOns: 3,
                  tradeWeekends: false,
                },
                settings: null,
              },
            },
          },
        });
      case '/api/strategy/futures':
        expect(url.searchParams.get('q')).toBe('IMOEXF');
        return route.fulfill({
          json: [
            {
              uid: 'future',
              ticker: 'IMOEXF',
              name: 'Индекс Мосбиржи',
              classCode: 'SPBFUT',
              exchange: 'MOEX',
              expirationDate: null,
            },
          ],
        });
      case '/api/backtest/run': {
        const parameters = request.postDataJSON();
        expect(parameters).toEqual({
          kind: 'surfing',
          instrumentUid: 'future',
          timeframe: '1h',
          emaPeriod: 55,
          lots: 3,
          from: '2026-10-18',
          to: '2026-10-19',
          commission: 0.0123,
          slippage: 0,
          initialMoney: 100000,
        });
        if (++requests === 2)
          return route.fulfill({
            status: 422,
            json: {
              code: 'BACKTEST_WARMUP_MISSING',
              details: { required: 55, available: 42, searchedFrom: '2026-10-01' },
            },
          });
        return route.fulfill({
          json: {
            parameters: { ...parameters, timeZone: 'Europe/Moscow' },
            currency: 'rub',
            pointValue: 10,
            priceStep: 0.5,
            priceStepAmount: 5,
            lot: 1,
            candles: [
              {
                time: Date.UTC(2026, 9, 18, 12),
                open: 101,
                high: 104,
                low: 100,
                close: 103,
                complete: true,
                ema: 102,
              },
              {
                time: Date.UTC(2026, 9, 18, 13),
                open: 103,
                high: 106,
                low: 102,
                close: 105,
                complete: true,
                ema: 102,
              },
            ],
            executions: [
              {
                time: Date.UTC(2026, 9, 18, 13),
                direction: 'buy',
                lots: 3,
                price: 103,
                commission: 0.38007,
                reason: 'entry',
              },
            ],
            equity: [
              { time: Date.UTC(2026, 9, 18, 12), value: 100000 },
              { time: Date.UTC(2026, 9, 18, 13), value: 100059.61993 },
            ],
            model: { missingMinutes: 4, marginPerLotAtClose: 105 },
            result: {
              closed: 0,
              open: 59.61993,
              total: 59.61993,
              position: 3,
              maxDrawdown: 0,
              commission: 0.38007,
              returnPercent: 0.05961993,
            },
          },
        });
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
  await expect(page.getByText(/Обе даты включительно по Москве/)).toBeVisible();
  await expect(page.getByText(/Лимит прогона: 30 календарных дней/)).toBeVisible();
  await page.getByLabel('Поиск фьючерса').fill('IMOEXF');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByLabel('Контракт').selectOption('future');
  await page.getByLabel('Период EMA').fill('55');
  await page.getByLabel('Объём, лотов').fill('3');
  await page.getByLabel('Комиссия, %').fill('0.0123');
  const dateRange = page.getByLabel('Диапазон дат');
  const october = page.getByRole('grid', { name: /октябрь 2026/i });
  await dateRange.click();
  await expect(page.getByRole('grid', { name: /ноябрь 2026/i })).toBeVisible();
  await page.getByRole('button', { name: /previous month/i }).click();
  await expect(october).toBeVisible();
  await page.getByRole('button', { name: /18/ }).click();
  await page.getByRole('button', { name: /19/ }).click();
  await expect(october).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(october).toBeHidden();
  await dateRange.click();
  await expect(october).toBeVisible();
  await page.keyboard.press('Escape');
  expect(requests).toBe(0);
  const run = page.getByRole('button', { name: 'Запустить бэктест' });
  await run.click();
  await expect(page.getByRole('heading', { name: 'Отчёт по стратегии' })).toBeVisible();
  await expect(page.getByText(/Комиссия 0,0123%/)).toBeVisible();
  await expect(page.getByRole('cell', { name: '0,3801' })).toBeVisible();
  await expect(page.getByText('Макс. просадка')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'График стоимости счёта' }).locator('canvas').first(),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Покупка', exact: true })).toBeVisible();
  const chart = page.getByRole('img', { name: 'График исторических свечей и EMA' });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(chart.locator('canvas[data-clock-tick="09:00"]')).toBeVisible();
  await expect(page.getByText('Время: America/New_York')).toBeVisible();
  await expect(page.getByRole('cell', { name: /09:00/ })).toBeVisible();
  await run.click();
  // A failed rerun keeps the last successful report visible instead of passing it off as the new result.
  await expect(page.getByText(/Для прогрева.*55.*Найдено: 42.*01\.10\.2026/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Отчёт по стратегии' })).toBeVisible();
  // The parameters are unchanged, so the surviving report is not flagged as stale.
  await expect(page.getByText('Параметры изменены')).toHaveCount(0);
});
