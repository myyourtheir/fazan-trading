import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { JournalEntry } from '../api/journal-api';
import type { Dashboard } from '../api/robot-api';
import type { ChartCandle } from '../model/market-data';

async function mockMarket(page: Page, options: { failInitialHistory?: boolean; historySize?: number } = {}) {
  const instrument = { uid: 'future', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
    exchange: 'MOEX', expirationDate: null };
  const selection = { instrumentUid: instrument.uid, emaPeriod: 3 };
  const time = Date.UTC(2026, 10, 18, 12);
  const candle = { time, open: 100, high: 110, low: 98, close: 104, complete: true,
    confirmedEma: 102, previewEma: null };
  const nextCandle = { ...candle, time: time + 3_600_000, complete: false, confirmedEma: null };
  const history = Array.from({ length: options.historySize ?? 1 }, (_, index) => ({
    ...candle, time: time - index * 3_600_000,
  })).reverse();
  let historyRequests = 0;
  let dashboard: Dashboard = { mode: 'stopped', reason: null, position: null };
  let journal: JournalEntry[] = [];
  await page.route('/api/**', route => {
    switch (new URL(route.request().url()).pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: dashboard });
      case '/api/robot/history':
        return route.fulfill({ json: journal });
      case '/api/robot/start':
        dashboard = { mode: 'running', reason: null, position: 0 };
        return route.fulfill({ status: 204 });
      case '/api/sandbox':
        return route.fulfill({ json: { status: 'unconfigured', accountId: null, accounts: [] } });
      case '/api/strategy':
        return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55 },
          settings: { instrument, emaPeriod: 3, lots: 1 } } });
      case '/api/market':
        if (++historyRequests === 1 && options.failInitialHistory) return route.fulfill({ status: 502 });
        return route.fulfill({ json: { ...selection, candles: history } });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/market/live', socket => { sockets.push(socket); });
  const tradingSockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/robot/live', socket => { tradingSockets.push(socket); });
  return { selection, candle, nextCandle, history, sockets, tradingSockets, confirmOrder: (order: JournalEntry) => {
    dashboard = { ...dashboard, position: order.position };
    journal = [order];
  } };
}

const chartCanvas = (page: Page) => page.getByRole('group', { name: 'График часовых свечей' })
  .getByRole('row').first().getByRole('cell').nth(1).locator('canvas').last();

test('starts the robot and refreshes its separate signal and fill after a live notification', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked sandbox data.');
  const { candle, sockets, tradingSockets, confirmOrder } = await mockMarket(page);
  await page.goto('/');
  await expect(page.getByText('Заявок пока нет.')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить робота' }).click();
  await expect(page.getByText('Робот запущен')).toBeVisible();
  await expect.poll(() => sockets.length).toBe(1);
  await expect.poll(() => tradingSockets.length).toBe(1);
  confirmOrder({
    id: 'client-order', ticker: 'IMOEXF', instrumentUid: 'future', accountId: 'virtual-account',
    candleTime: candle.time, signalTime: candle.time + 3_600_000, signalPrice: 104, ema: 102, direction: 'buy',
    lots: 1, fromPosition: 0, targetPosition: 1, brokerStatus: 'filled', status: 'confirmed',
    position: 1, executedLots: 1, brokerOrderId: 'exchange-order',
    executions: [{ tradeId: 'trade', lots: 1, price: 105.25, time: candle.time + 3_605_000 }],
  });
  tradingSockets[0].send(JSON.stringify({ tradingChanged: true }));
  await expect(page.getByText('Подтверждённая позиция: 1')).toBeVisible();
  const row = page.getByRole('article');
  await expect(row.getByText('Цена сигнала: 104')).toBeVisible();
  await expect(row.getByText('Лотов: 1; цена сделки: 105,25')).toBeVisible();
  await expect(row.getByText('Исполнено лотов: 1')).toBeVisible();
});

test('charts REST history, replaces live candles, and restores the chart after a socket drops', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked market data.');
  const { selection, candle, nextCandle, sockets } = await mockMarket(page);
  await page.goto('/');
  const chart = page.getByRole('region', { name: 'Часовые свечи и EMA' });
  const latest = chart.getByLabel('Последняя свеча');
  const plot = chart.getByRole('group', { name: 'График часовых свечей' });
  await expect(plot).toBeVisible();
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
  const canvas = chartCanvas(page);
  const box = (await canvas.boundingBox())!;
  const chartRows = plot.getByRole('row');
  await expect(chartRows.first().getByRole('cell').nth(2).locator('canvas').last()).toBeVisible();
  await expect(chartRows.nth(1).getByRole('cell').nth(1).locator('canvas').last()).toBeVisible();
  await canvas.hover({ position: { x: box.width * 0.2, y: box.height / 2 } });
  const selected = chart.getByLabel('Выбранная свеча');
  await expect(selected).toContainText('12:00 UTC');
  await expect(selected).toContainText('Открытие100');
  await expect(selected).toContainText('Максимум110');
  await expect(selected).toContainText('Минимум98');
  await expect(selected).toContainText('Закрытие104');
  await chart.getByRole('heading').hover();
  await expect(latest).toContainText('13:00 UTC');
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
  await chart.getByRole('heading').hover();
  await expect(chart.getByLabel('Последняя свеча')).toContainText('107');
});

test('zooming and scrolling history keeps the selected time across live updates and backfill', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked market data.');
  const { selection, nextCandle, history, sockets } = await mockMarket(page, { historySize: 80 });
  await page.goto('/');
  const chart = page.getByRole('region', { name: 'Часовые свечи и EMA' });
  const plot = chart.getByRole('group', { name: 'График часовых свечей' });
  const canvas = chartCanvas(page);
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const y = box.y + box.height / 2;
  const position = { x: box.width / 2, y: box.height / 2 };
  const selectedTime = chart.getByLabel('Выбранная свеча').locator('dd').first();
  const timeAtCenter = async () => {
    await canvas.hover({ position });
    return selectedTime.innerText();
  };
  const beforeZoom = await timeAtCenter();
  for (let index = 0; index < 4; index++) {
    const before = index === 0 ? beforeZoom : await timeAtCenter();
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.wheel(0, -450);
    await expect.poll(timeAtCenter).not.toBe(before);
  }
  const zoomed = await timeAtCenter();
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, y, { steps: 8 });
  await page.mouse.up();
  const past = await timeAtCenter();
  expect(past).not.toBe(zoomed);
  await expect.poll(() => sockets.length).toBe(1);
  const publish = (candles: ChartCandle[]) => sockets[0].send(JSON.stringify({ stream: 'live', history: { ...selection, candles } }));

  publish([...history, nextCandle]);
  await expect(chart.getByText(/81 св\./)).toBeVisible();
  expect(await timeAtCenter()).toBe(past);
  publish([...history.slice(1), { ...nextCandle, close: 106 }]);
  await expect(chart.getByText(/80 св\./)).toBeVisible();
  expect(await timeAtCenter()).toBe(past);

  await chart.getByRole('button', { name: 'К последней свече' }).click();
  await expect.poll(timeAtCenter).not.toBe(past);

  const priceAxis = plot.getByRole('row').first().getByRole('cell').nth(2).locator('canvas');
  const axisPixels = () => priceAxis.first().evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await priceAxis.last().scrollIntoViewIfNeeded();
  const axis = (await priceAxis.last().boundingBox())!;
  const axisBeforeScale = await axisPixels();
  await page.mouse.move(axis.x + axis.width / 2, axis.y + axis.height / 2);
  await page.mouse.down();
  await page.mouse.move(axis.x + axis.width / 2, axis.y + axis.height * 0.78, { steps: 8 });
  await page.mouse.up();
  await expect.poll(axisPixels).not.toBe(axisBeforeScale);

  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
