import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { ChartCandle } from '../src/market-data';

async function mockMarket(page: Page, options: { failInitialHistory?: boolean } = {}) {
  const instrument = { uid: 'future', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
    exchange: 'MOEX', expirationDate: null };
  const selection = { instrumentUid: instrument.uid, emaPeriod: 3 };
  const time = Date.UTC(2026, 10, 18, 12);
  const candle = { time, open: 100, high: 110, low: 98, close: 104, complete: true,
    confirmedEma: 102, previewEma: null };
  const nextCandle = { ...candle, time: time + 3_600_000, complete: false, confirmedEma: null };
  let historyRequests = 0;
  await page.route('**/api/**', route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped' } });
      case '/api/sandbox':
        return route.fulfill({ json: { status: 'unconfigured', accountId: null, accounts: [] } });
      case '/api/strategy':
        return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55 },
          settings: { instrument, emaPeriod: 3, lots: 1 } } });
      case '/api/market':
        if (++historyRequests === 1 && options.failInitialHistory) return route.fulfill({ status: 502 });
        return route.fulfill({ json: { ...selection, candles: [candle] } });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/market/live', socket => { sockets.push(socket); });
  return { selection, candle, nextCandle, sockets };
}

test('charts REST history, replaces live candles, and restores the chart after a socket drops', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked market data.');
  const { selection, candle, nextCandle, sockets } = await mockMarket(page);
  await page.goto('/');
  const chart = page.getByRole('region', { name: 'Часовые свечи и EMA' });
  const latest = chart.getByLabel('Последняя свеча');
  await expect(chart.getByRole('img')).toBeVisible();
  await expect(chart.getByText(/1 св\./)).toBeVisible();
  await expect(latest).toContainText('Подтверждённая EMA');
  await expect.poll(() => sockets.length).toBe(1);
  const publish = (socket: WebSocketRoute, last: ChartCandle) =>
    socket.send(JSON.stringify({ stream: 'live', history: { ...selection, candles: [candle, last] } }));

  publish(sockets[0], { ...nextCandle, close: 108, previewEma: 105 });
  await expect(latest).toContainText('Предварительная EMA');
  await expect(latest).toContainText('105');
  await expect(chart.getByText('Поток подключён')).toBeVisible();
  await expect(page.getByText('Робот остановлен')).toBeVisible();
  publish(sockets[0], { ...nextCandle, close: 110, previewEma: 106 });
  await expect(latest).toContainText('106');
  await expect(chart.getByText(/2 св\./)).toBeVisible();

  await sockets[0].close({ code: 1011 });
  await expect(chart.getByText('Поток прерван')).toBeVisible();
  await expect(latest).not.toContainText('Предварительная EMA');
  await expect.poll(() => sockets.length).toBe(2);
  publish(sockets[1], { ...nextCandle, close: 110, complete: true, previewEma: null });
  await expect(latest).toContainText('Нет подтверждения');
  await expect(chart.getByText(/2 св\./)).toBeVisible();
});

test('live ticks remain visible when initial REST history fails', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked market data.');
  const { selection, nextCandle, sockets } = await mockMarket(page, { failInitialHistory: true });
  await page.goto('/');
  const chart = page.getByRole('region', { name: 'Часовые свечи и EMA' });
  await expect(chart.getByText('Не удалось загрузить историю свечей.')).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);
  sockets[0].send(JSON.stringify({ stream: 'live', tick: { ...selection, candle: { ...nextCandle, close: 107 } } }));
  await expect(chart.getByRole('status')).toHaveText('Поток подключён');
  await expect(chart.getByLabel('Последняя свеча')).toContainText('107');
  await chart.getByRole('button', { name: 'Повторить' }).click();
  await expect(chart.getByText(/2 св\./)).toBeVisible();
  await expect(chart.getByLabel('Последняя свеча')).toContainText('107');
});
