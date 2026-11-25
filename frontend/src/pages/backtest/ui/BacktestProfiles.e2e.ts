import { expect, test, type Locator } from '@playwright/test';
import type { BacktestReport, BacktestRequest } from '../api/backtest-api';

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

function reportFor(parameters: BacktestRequest): BacktestReport {
  const start = Date.UTC(2026, 10, 18, 10);
  const minute = 60_000;
  return {
    parameters: { ...parameters, timeZone: 'Europe/Moscow' },
    coverage: {
      requested: { from: parameters.from, to: parameters.to },
      actual: { from: start, to: start + 120 * minute },
      uncoveredStart: false,
      uncoveredEnd: false,
    },
    currency: 'rub',
    pointValue: 10,
    priceStep: 0.5,
    priceStepAmount: 5,
    lot: 1,
    candles: Array.from({ length: 4 }, (_, i) => ({
      time: start + i * 30 * minute,
      open: 100 + i,
      high: 104 + i,
      low: 99 + i,
      close: 103 + i,
      ema: 101 + i,
    })),
    executions: [],
    equity: Array.from({ length: 121 }, (_, i) => ({
      time: start + i * minute,
      value: 100_000 + i,
    })),
    model: { missingMinutes: 0, marginPerLotAtClose: 105 },
    result: {
      closed: 0,
      open: 120,
      total: 120,
      position: 1,
      maxDrawdown: 0,
      commission: 0,
      returnPercent: 0.12,
    },
  };
}

function canvasText(chart: Locator, attribute: 'axisTicks' | 'hoverTime') {
  return chart.locator('canvas').evaluateAll((canvases, key) => {
    return canvases.flatMap((canvas) => {
      const value = (canvas as HTMLCanvasElement).dataset[key];
      return value ? [value] : [];
    });
  }, attribute);
}

test('backtest uses saved profiles and links only the Improved Surfing report charts', async ({
  page,
}) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked backtest run.');
  await page.clock.install({ time: '2026-11-20T12:00:00Z' });
  await page.addInitScript(() => {
    // The time-axis ticks and crosshair labels are drawn on canvas.
    const { clearRect, fillRect, fillText } = CanvasRenderingContext2D.prototype;
    function reset(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
      if (x === 0 && y === 0 && w === canvas.width && h === canvas.height) {
        delete canvas.dataset.axisTicks;
        delete canvas.dataset.hoverTime;
      }
    }
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      reset(this.canvas, x, y, w, h);
      clearRect.call(this, x, y, w, h);
    };
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
      reset(this.canvas, x, y, w, h);
      fillRect.call(this, x, y, w, h);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^\d{2}:\d{2}$/.test(text)) {
        this.canvas.dataset.axisTicks =
          (this.canvas.dataset.axisTicks ?? '') + `${text}@${Math.round(x)} `;
      }
      if (text.endsWith(' GMT-5')) this.canvas.dataset.hoverTime = text;
      if (maxWidth === undefined) fillText.call(this, text, x, y);
      else fillText.call(this, text, x, y, maxWidth);
    };
  });
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
        return route.fulfill({ json: { timeZone: 'America/New_York' } });
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
      case '/api/backtest/run': {
        const parameters = request.postDataJSON() as BacktestRequest;
        runs.push(parameters);
        return runs.length === 1
          ? route.fulfill({ status: 422, json: { code: 'BACKTEST_NO_CONFIRMED_INTERVALS' } })
          : route.fulfill({ json: reportFor(parameters) });
      }
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

  const run = page.getByRole('button', { name: 'Запустить бэктест' });
  await run.click();
  const equity = page.getByRole('img', { name: 'График стоимости счёта' });
  const history = page.getByRole('img', { name: 'График исторических свечей и EMA' });
  await expect.poll(() => canvasText(equity, 'axisTicks')).not.toEqual([]);
  const fullRange = await canvasText(equity, 'axisTicks');
  await expect.poll(() => canvasText(history, 'axisTicks')).toEqual(fullRange);

  async function hover(chart: Locator, ratio: number) {
    const pane = chart.locator('canvas').first();
    await pane.scrollIntoViewIfNeeded();
    const bounds = (await pane.boundingBox())!;
    const x = bounds.x + ratio * bounds.width;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    return { x, y };
  }

  await hover(equity, 0.46);
  await expect.poll(() => canvasText(equity, 'hoverTime')).toHaveLength(1);
  const equityHover = await canvasText(equity, 'hoverTime');
  expect(equityHover[0]).toMatch(/05:(?!00|30)\d{2} GMT-5$/); // No 30-minute candle starts here.
  await expect.poll(() => canvasText(history, 'hoverTime')).toEqual(equityHover);

  await hover(history, 0.67);
  await expect.poll(() => canvasText(history, 'hoverTime')).not.toEqual(equityHover);
  await expect.poll(() => canvasText(history, 'hoverTime')).toHaveLength(1);
  await expect
    .poll(() => canvasText(equity, 'hoverTime'))
    .toEqual(await canvasText(history, 'hoverTime'));
  await page.mouse.move(1, 1);
  await expect.poll(() => canvasText(history, 'hoverTime')).toEqual([]);
  await expect.poll(() => canvasText(equity, 'hoverTime')).toEqual([]);

  await hover(equity, 0.5);
  await page.mouse.wheel(0, -800);
  await expect.poll(() => canvasText(equity, 'axisTicks')).not.toEqual(fullRange);
  const zoomed = await canvasText(equity, 'axisTicks');
  await expect.poll(() => canvasText(history, 'axisTicks')).toEqual(zoomed);

  const { x, y } = await hover(history, 0.5);
  await page.mouse.down();
  await page.mouse.move(x + 140, y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const [priceTicks, equityTicks] = await Promise.all([
        canvasText(history, 'axisTicks'),
        canvasText(equity, 'axisTicks'),
      ]);
      return Boolean(
        priceTicks[0] && priceTicks[0] !== zoomed[0] && priceTicks[0] === equityTicks[0],
      );
    })
    .toBe(true);

  await run.click();
  await expect.poll(() => canvasText(equity, 'axisTicks')).toEqual(fullRange);
  await expect.poll(() => canvasText(history, 'axisTicks')).toEqual(fullRange);

  await kind.selectOption('surfing');
  await expect(page.getByLabel('Объём, лотов')).toHaveValue('3');
  await expect(page.getByLabel('Период EMA')).toHaveValue('44');
  await expect(range).toHaveText('18.11.2026 — 19.11.2026');
  await expect(page.getByLabel('Комиссия, %')).toHaveValue('0.1');
  await expect(page.getByLabel('Проскальзывание, шагов цены')).toHaveValue('2');
  await run.click();
  await expect(page.getByText(/Surfing · 3 лот/)).toBeVisible();
  await hover(equity, 0.46);
  await expect.poll(() => canvasText(equity, 'hoverTime')).toHaveLength(1);
  await expect.poll(() => canvasText(history, 'hoverTime')).toEqual([]);
  await page.reload();
  await expect(kind).toHaveValue('improved-surfing');
  await expect(page.getByLabel('Период ATR')).toHaveValue('10');
  expect(mutations).toEqual([]);
});
