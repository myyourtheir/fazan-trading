import { expect, test, type WebSocketRoute } from '@playwright/test';
import type { Timeframe } from '../model/timeframe';

test('strategy starts with IMOEXF and EMA55, requires an explicit contract, and restores saved values', async ({ page }) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked futures catalogue.');
  const contracts = [
    { uid: 'continuous-uid', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
      exchange: 'MOEX', expirationDate: null },
    { uid: 'quarterly-uid', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT',
      exchange: 'MOEX', expirationDate: '2027-03-18T00:00:00.000Z' },
  ];
  let saved: { instrument: (typeof contracts)[number]; emaPeriod: number; lots: number; timeframe: Timeframe } | null = null;
  let available = true;
  let catalogue = contracts;
  await page.route('/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60_000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: null } });
      case '/api/sandbox':
        return route.fulfill({ json: available
          ? { status: 'connected', accountId: 'sandbox-1', accounts: [{ id: 'sandbox-1', name: 'Песочница' }],
              virtualFundingRubles: 100_000 }
          : { status: 'unavailable', accountId: 'sandbox-1', accounts: [], code: 'SANDBOX_UNREACHABLE' } });
      case '/api/strategy/futures':
        return route.fulfill({ json: ['IMOEXF', 'Мосбиржи'].includes(url.searchParams.get('q') ?? '') ? catalogue : [] });
      case '/api/market':
        return route.fulfill({ json: saved
          ? { instrumentUid: saved.instrument.uid, emaPeriod: saved.emaPeriod, timeframe: saved.timeframe, candles: [] }
          : null });
      case '/api/strategy':
        if (request.method() === 'GET') {
          return route.fulfill({ json: { defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' }, settings: saved } });
        }
        expect(request.postDataJSON()).toEqual({
          accountId: 'sandbox-1', instrumentUid: 'quarterly-uid', emaPeriod: 34, lots: 3, timeframe: '15m',
        });
        saved = { instrument: contracts[1], emaPeriod: 34, lots: 3, timeframe: '15m' };
        return route.fulfill({ status: 204 });
      default:
        return route.fulfill({ status: 404 });
    }
  });
  let marketSocket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/api/market/live', socket => {
    marketSocket = socket;
    socket.send(JSON.stringify({ stream: 'live' }));
  });
  await page.routeWebSocket('**/api/robot/live', () => {});

  await page.goto('/');
  const strategy = page.getByRole('region', { name: 'Настройки стратегии' });
  const search = strategy.getByLabel('Поиск фьючерса');
  const select = strategy.getByLabel('Контракт');
  const period = strategy.getByLabel('Период EMA');
  const timeframe = strategy.getByLabel('Таймфрейм');
  const lots = strategy.getByLabel('Объём, лотов');
  const save = strategy.getByRole('button', { name: 'Сохранить настройки' });
  await expect(search).toHaveValue('IMOEXF');
  await expect(period).toHaveValue('55');
  await expect(timeframe).toHaveValue('1h');
  await expect(lots).toHaveValue('');
  await expect(select.getByRole('option')).toHaveCount(3);
  await expect(select.getByRole('option', { name: 'IMOEXF', exact: true })).toHaveCount(2);
  await lots.fill('3');
  await expect(save).toBeDisabled();
  await search.fill('Мосбиржи');
  const searchRequest = page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'Мосбиржи');
  await search.press('Enter');
  await searchRequest;
  await expect(select.getByRole('option')).toHaveCount(3);
  await select.selectOption('quarterly-uid');
  await period.fill('34');
  await timeframe.selectOption('15m');
  await save.click();
  await expect(strategy.getByText('Настройки сохранены.')).toBeVisible();
  const chart = page.getByRole('region', { name: 'Свечи и EMA' });
  await expect(chart).toContainText('IMOEXF · 15 минут · EMA 34');
  await expect(chart.getByText('Поток подключён')).toBeVisible();
  const candle = { time: Date.UTC(2026, 10, 18, 12), open: 101, high: 105, low: 100, close: 104,
    complete: false, confirmedEma: null, previewEma: null };
  const sendTick = (timeframe: Timeframe) => marketSocket!.send(JSON.stringify({
    stream: 'live', tick: { instrumentUid: 'quarterly-uid', emaPeriod: 34, timeframe, candle },
  }));
  sendTick('1h');
  // Use a matching snapshot as a delivery barrier without adding any candles.
  marketSocket!.send(JSON.stringify({ stream: 'connecting', history: {
    instrumentUid: 'quarterly-uid', emaPeriod: 34, timeframe: '15m', candles: [],
  } }));
  await expect(chart.getByText('Подключаем поток…')).toBeVisible();
  await expect(chart.getByText('Нет свечей за последние семь дней.')).toBeVisible();
  sendTick('15m');
  await expect(chart.getByRole('group', { name: 'График свечей' })).toBeVisible();

  await page.reload();
  await expect(select).toHaveValue('quarterly-uid');
  await expect(strategy.getByText('Выбран контракт:', { exact: true })).toHaveCount(0);
  await expect(period).toHaveValue('34');
  await expect(timeframe).toHaveValue('15m');
  await expect(lots).toHaveValue('3');

  catalogue = [contracts[0]];
  await page.reload();
  await expect(select.getByRole('option')).toHaveCount(2);
  await expect(select).toHaveValue('');
  await expect(save).toBeDisabled();

  available = false;
  await page.reload();
  await expect(select).toBeDisabled();
  await expect(period).toHaveValue('34');
  await expect(lots).toHaveValue('3');
  await expect(timeframe).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
