import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { OwnerAuth, type SessionStore } from '../core/auth.js';
import { BacktestHistory, type BacktestBroker } from '../core/backtest-history.js';
import { DisplaySettings } from '../core/display-settings.js';
import { createApp } from './app.js';

const password = 'backtest-test-owner-password';
const hour = 3_600_000;
const start = Date.parse('2026-11-17T21:00:00Z');
const form = {
  instrumentUid: 'future',
  emaPeriod: 55,
  lots: 3,
  timeframe: '1h',
  from: '2026-11-18',
  to: '2026-11-18',
  commission: 0,
  slippage: 0,
};
const moscow = 'Europe/Moscow';
const candle = (time: number, close: number, complete = true) => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  complete,
});
const warmup = (last: number) =>
  Array.from({ length: form.emaPeriod }, (_, index) =>
    candle(
      start - (form.emaPeriod - index) * hour,
      index === 0 ? 200 - last : index === form.emaPeriod - 1 ? last : 100,
    ),
  );

async function serve(t: TestContext, broker: BacktestBroker, now = start + 25 * hour) {
  const sessions = new Map<string, Date>();
  const store: SessionStore = {
    async create(digest, expiresAt) {
      sessions.set(digest, expiresAt);
    },
    async activeUntil(digest) {
      return sessions.get(digest) ?? null;
    },
    async revoke(digest) {
      sessions.delete(digest);
    },
  };
  const auth = await OwnerAuth.create(password, store);
  let timeZone = moscow;
  const displaySettings = new DisplaySettings({
    async loadTimeZone() {
      return timeZone;
    },
    async saveTimeZone(value) {
      timeZone = value;
    },
  });
  const server = createApp({
    auth,
    secureCookies: false,
    displaySettings,
    backtest: new BacktestHistory(
      broker,
      async () => 'private-test-token',
      () => now,
    ),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = async (
    path: string,
    body?: object,
    cookie = '',
    method = body ? 'POST' : 'GET',
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Serfing-Request': '1', cookie },
      body: body && JSON.stringify(body),
    });
    const payload = await response.text();
    assert.ok(!payload.includes('private-test-token'));
    return {
      status: response.status,
      body: JSON.parse(payload),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  return {
    request,
    async authorize() {
      const session = await request('auth/login', { password });
      assert.ok(session.cookie);
      return session.cookie;
    },
  };
}

function data() {
  const candles = [
    ...warmup(99),
    candle(start, 101),
    candle(start + 12 * hour, 103),
    candle(start + 24 * hour, 105),
  ];
  const calls: [number, number][] = [];
  const broker: BacktestBroker = {
    async backtestFuture() {
      return {
        firstTrade: undefined,
        lastTrade: undefined,
        currency: 'rub',
        priceStep: 1,
        priceStepAmount: 1,
        lot: 1,
      };
    },
    async candles(token, uid, timeframe, from, to) {
      assert.deepEqual([token, uid, timeframe], ['private-test-token', 'future', '1h']);
      calls.push([+from, +to]);
      return candles.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
  };
  return { broker, calls, candles };
}

test('only the owner can check a bounded Moscow period independently of the robot or account', async (t) => {
  const { broker, calls } = data();
  const { request, authorize } = await serve(t, broker);
  assert.equal((await request('backtest/limits')).status, 401);
  assert.equal((await request('backtest/history', form)).status, 401);
  const cookie = await authorize();
  const { body: limits } = await request('backtest/limits', undefined, cookie);
  assert.equal(limits.maxDays, 30);
  assert.equal(limits.maxEmaPeriod, 1000);
  for (const invalid of [
    { lots: 0 },
    { lots: 1.5 },
    { emaPeriod: 1001 },
    { timeframe: '1m' },
    { instrumentUid: '' },
    { from: '2026-11-31' },
    { from: '2026-11-19' },
    { to: '2026-11-20' },
    { commission: -0.1 },
    { slippage: '1' },
    { commission: null },
    { slippage: Infinity },
  ])
    assert.equal((await request('backtest/history', { ...form, ...invalid }, cookie)).status, 400);
  // Just over the 30-day limit: 2026-10-19–2026-11-18 spans 31 inclusive calendar days.
  const tooLong = await request('backtest/history', { ...form, from: '2026-10-19' }, cookie);
  assert.equal(tooLong.body.code, 'BACKTEST_PERIOD_TOO_LONG');
  assert.equal(calls.length, 0);
  const response = await request('backtest/history', form, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.parameters, { ...form, timeZone: moscow });
  assert.equal(response.body.cutoff, null);
  const firstEma = 100 + 1 / 28;
  assert.deepEqual(response.body.candles, [
    { ...candle(start, 101), ema: firstEma },
    { ...candle(start + 12 * hour, 103), ema: firstEma + (103 - firstEma) / 28 },
  ]);
  assert.ok(calls.some(([, to]) => to === start + 24 * hour));
});

for (const [date, from, to] of [
  ['2026-03-08', '2026-03-08T05:00Z', '2026-03-09T04:00Z'],
  ['2026-11-01', '2026-11-01T04:00Z', '2026-11-02T05:00Z'],
]) {
  test(`the saved New York timezone defines both boundaries of the DST day ${date}`, async (t) => {
    const { broker, calls, candles } = data();
    const start = Date.parse(from);
    const end = Date.parse(to);
    candles.splice(
      0,
      candles.length,
      candle(start - hour, 100),
      candle(start, 101),
      candle(end - hour, 103),
      candle(end, 105),
    );
    const { request, authorize } = await serve(t, broker, end + hour);
    const cookie = await authorize();
    const timeZone = 'America/New_York';
    assert.equal((await request('settings/display', { timeZone }, cookie, 'PUT')).status, 200);
    const parameters = { ...form, emaPeriod: 1, from: date, to: date };
    for (const endpoint of ['history', 'run']) {
      calls.length = 0;
      const result = await request(
        `backtest/${endpoint}`,
        { ...parameters, timeZone: 'UTC' },
        cookie,
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.parameters, { ...parameters, timeZone });
      assert.deepEqual(calls[0], [start, end]);
      assert.deepEqual(
        result.body.candles.map((row: { time: number }) => row.time),
        [start, end - hour],
      );
    }
  });
}

test('the next UTC date is still in the future when it has not started in the saved timezone', async (t) => {
  const { broker, calls } = data();
  const { request, authorize } = await serve(t, broker, Date.parse('2026-11-19T02:00Z'));
  const cookie = await authorize();
  await request('settings/display', { timeZone: 'America/New_York' }, cookie, 'PUT');
  const response = await request('backtest/history', { ...form, to: '2026-11-19' }, cookie);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('overlapping pages do not duplicate candles or reset the EMA', async (t) => {
  const { broker, calls, candles } = data();
  const boundary = start + (6 * 24 - 1) * hour;
  candles.push(candle(boundary, 109));
  const { request, authorize } = await serve(t, broker, start + 8 * 24 * hour);
  const cookie = await authorize();
  const query = { ...form, to: '2026-11-24' };
  const success = await request('backtest/history', query, cookie);
  assert.equal(success.status, 200);
  const rows = success.body.candles as { time: number; ema: number }[];
  assert.deepEqual(
    rows.map((row) => row.time),
    [start, start + 12 * hour, start + 24 * hour, boundary],
  );
  assert.equal(rows[3].ema, rows[2].ema + (109 - rows[2].ema) / 28);
  assert.ok(calls.filter(([from, to]) => from <= boundary && boundary <= to).length > 1);

  assert.equal(
    (await request('backtest/history', { ...form, from: '2026-11-25', to: '2026-11-25' }, cookie))
      .body.code,
    'BACKTEST_CANDLES_MISSING',
  );
});

test('an expired contract or conflicting candles cannot produce a successful check', async (t) => {
  const { broker } = data();
  const getFuture = broker.backtestFuture;
  broker.backtestFuture = async (...args) => ({
    ...(await getFuture(...args)),
    lastTrade: new Date(start - hour),
  });
  const { request, authorize } = await serve(t, broker, start + 8 * 24 * hour);
  const cookie = await authorize();
  const expired = await request('backtest/history', form, cookie);
  assert.equal(expired.status, 422);
  assert.equal(expired.body.code, 'BACKTEST_CONTRACT_PERIOD');

  broker.backtestFuture = getFuture;
  const readCandles = broker.candles;
  const overlap = start + (6 * 24 - 1) * hour;
  broker.candles = async (...args) => {
    const bars = await readCandles(...args);
    const [, , , from, to] = args;
    if (+from <= overlap && overlap <= +to) bars.push(candle(overlap, 100 + Number(+from > start)));
    return bars;
  };
  const conflict = await request('backtest/history', { ...form, to: '2026-11-24' }, cookie);
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.code, 'BACKTEST_HISTORY_CONFLICT');
});

test('warmup searches beyond seven days and uses only the nearest distinct completed candles', async (t) => {
  const { broker, candles, calls } = data();
  const day = 24 * hour;
  candles.splice(
    0,
    candles.length,
    candle(start - 9 * day, 999),
    candle(start - 8 * day, 120),
    candle(start - 6 * day + hour, 90),
    candle(start - hour, 90),
    candle(start - 2 * hour, 999, false),
    candle(start, 110),
  );
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const response = await request('backtest/history', { ...form, emaPeriod: 3 }, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.candles, [{ ...candle(start, 110), ema: 105 }]);
  assert.equal(calls.length, 3);
});

test('insufficient warmup stops at the contract start or the one-year limit and reports the actual count', async (t) => {
  const { broker, candles, calls } = data();
  candles.push(candle(start - 5_000 * hour, 100));
  const getFuture = broker.backtestFuture;
  broker.backtestFuture = async (...args) => ({
    ...(await getFuture(...args)),
    firstTrade: new Date(start - 48 * hour),
  });
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const insufficient = await request('backtest/run', form, cookie);
  assert.equal(insufficient.status, 422);
  assert.deepEqual(insufficient.body, {
    code: 'BACKTEST_WARMUP_MISSING',
    details: { required: 55, available: 48, searchedFrom: '2026-11-16' },
  });
  assert.equal(Math.min(...calls.map(([from]) => from)), start - 48 * hour);

  broker.backtestFuture = getFuture;
  calls.length = 0;
  const bounded = await request('backtest/history', { ...form, emaPeriod: 1000 }, cookie);
  assert.equal(bounded.status, 422);
  assert.deepEqual(bounded.body, {
    code: 'BACKTEST_WARMUP_MISSING',
    details: { required: 1000, available: 56, searchedFrom: '2025-11-18' },
  });
  assert.equal(Math.min(...calls.map(([from]) => from)), start - 365 * 24 * hour);
});

test('today reports the effective cutoff and does not treat a forming candle as history', async (t) => {
  const { broker, candles } = data();
  const current = start + 13 * hour;
  const cutoff = current + hour / 2;
  candles.push(candle(current - 2 * hour, 102, false), candle(current, 104, false));
  const { request, authorize } = await serve(t, broker, cutoff);
  const cookie = await authorize();
  const incomplete = await request('backtest/history', form, cookie);
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.code, 'BACKTEST_CANDLES_MISSING');
  candles.splice(
    candles.findIndex((bar) => bar.time === current - 2 * hour),
    1,
  );
  const result = await request('backtest/history', form, cookie);
  assert.equal(result.status, 200);
  assert.equal(result.body.cutoff, cutoff);
  assert.deepEqual(
    result.body.candles.map((bar: { time: number }) => bar.time),
    [start, start + 12 * hour],
  );
});

function runCandle(time: number, open: number, close: number, complete = true) {
  return { time, open, high: Math.max(open, close), low: Math.min(open, close), close, complete };
}

// The EMA starts at 100; closes cross it up, down, and then up again.
function runData() {
  const bars = [
    ...warmup(90), // baseline below the EMA
    runCandle(start, 100, 105), // crossing up
    runCandle(start + hour, 101, 98), // crossing down
    runCandle(start + 2 * hour, 103, 100), // stays below the EMA
    runCandle(start + 3 * hour, 104, 95),
    runCandle(start + 4 * hour, 97, 110), // crossing up again
    runCandle(start + 5 * hour, 112, 112),
  ];
  const broker: BacktestBroker = {
    async backtestFuture() {
      return {
        firstTrade: undefined,
        lastTrade: undefined,
        currency: 'rub',
        priceStep: 0.5,
        priceStepAmount: 5,
        lot: 1,
      };
    },
    async candles(_token, _uid, _timeframe, from, to) {
      return bars.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
  };
  return { broker, bars };
}

test('running the backtest reports executions and money without touching the robot or account', async (t) => {
  const { broker } = runData();
  // The run goes through BacktestBroker (candles/backtestFuture only): the fake has no order,
  // stream, robot, or journal methods, so a successful report here proves none were used.
  const { request, authorize } = await serve(t, broker);
  assert.equal((await request('backtest/run', form)).status, 401);
  const cookie = await authorize();
  const response = await request('backtest/run', form, cookie);
  assert.equal(response.status, 200);
  const { body } = response;
  assert.deepEqual(body.parameters, { ...form, timeZone: moscow });
  assert.equal(body.currency, 'rub');
  assert.equal(body.pointValue, 10);
  assert.deepEqual(body.executions, [
    { time: start + hour, direction: 'buy', lots: 3, price: 101, commission: 0 },
    { time: start + 2 * hour, direction: 'sell', lots: 6, price: 103, commission: 0 },
    { time: start + 5 * hour, direction: 'buy', lots: 6, price: 112, commission: 0 },
  ]);
  assert.equal(body.finalSignal, null);
  assert.deepEqual(body.result, {
    closed: -210,
    open: 0,
    total: -210,
    position: 3,
    maxDrawdown: 510,
  });
  assert.equal(body.candles.length, 6);
  assert.ok(!JSON.stringify(body).includes('private-test-token'));
});

test('EMA(1) equals the close and yields zero executions', async (t) => {
  const { broker } = runData();
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const response = await request('backtest/run', { ...form, emaPeriod: 1 }, cookie);
  assert.equal(response.status, 200);
  assert.ok(
    response.body.candles.every((row: { close: number; ema: number }) => row.close === row.ema),
  );
  assert.deepEqual(response.body.executions, []);
  assert.deepEqual(response.body.result, {
    closed: 0,
    open: 0,
    total: 0,
    position: 0,
    maxDrawdown: 0,
  });
});

test('with no strict warmup side, the first strict close establishes it without a signal', async (t) => {
  const { broker, candles } = data();
  candles.splice(
    0,
    candles.length,
    candle(start - 2 * hour, 100),
    candle(start - hour, 100),
    candle(start, 105),
    candle(start + hour, 95),
    candle(start + 2 * hour, 95),
  );
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const response = await request('backtest/run', { ...form, emaPeriod: 2 }, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.executions, [
    { time: start + 2 * hour, direction: 'sell', lots: 3, price: 95, commission: 0 },
  ]);
});

test('a signal on the final candle is reported without an execution', async (t) => {
  const { broker, bars } = runData();
  broker.candles = async (_token, _uid, _timeframe, from, to) =>
    bars.filter(({ time }) => time >= +from && time <= +to && time <= start + hour).reverse();
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const response = await request('backtest/run', form, cookie);
  assert.equal(response.status, 200);
  assert.equal(response.body.executions.length, 1);
  assert.deepEqual(response.body.finalSignal, {
    candleTime: start + hour,
    direction: 'sell',
    targetPosition: -3,
  });
});

test('a contract without money parameters cannot produce a money report', async (t) => {
  const { broker } = runData();
  broker.backtestFuture = async () => ({
    firstTrade: undefined,
    lastTrade: undefined,
    currency: 'rub',
    priceStep: null,
    priceStepAmount: 5,
    lot: 1,
  });
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const response = await request('backtest/run', form, cookie);
  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'BACKTEST_CONTRACT_PARAMS_MISSING');
});

// An entry, a full reversal to the other side, and an open remainder at the last close.
function costData() {
  const bars = [
    ...warmup(90), // baseline below the EMA
    runCandle(start, 100, 105), // crossing up
    runCandle(start + hour, 101, 98), // crossing down -> reverse
    runCandle(start + 2 * hour, 103, 95),
    runCandle(start + 3 * hour, 99, 97),
    runCandle(start + 4 * hour, 96, 94), // remainder stays short
  ];
  const broker: BacktestBroker = {
    async backtestFuture() {
      return {
        firstTrade: undefined,
        lastTrade: undefined,
        currency: 'rub',
        priceStep: 0.5,
        priceStepAmount: 5,
        lot: 1,
      };
    },
    async candles(_token, _uid, _timeframe, from, to) {
      return bars.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
  };
  return { broker, bars };
}

test('costs and drawdown match a precomputed example over both sides, a reversal and a remainder', async (t) => {
  const { broker } = costData();
  const { request, authorize } = await serve(t, broker);
  const cookie = await authorize();
  const withCosts = await request('backtest/run', { ...form, commission: 25 }, cookie);
  assert.equal(withCosts.status, 200);
  const { body } = withCosts;
  assert.deepEqual(body.executions, [
    { time: start + hour, direction: 'buy', lots: 3, price: 101, commission: 757.5 },
    { time: start + 2 * hour, direction: 'sell', lots: 6, price: 103, commission: 1545 },
  ]);
  assert.deepEqual(body.result, {
    closed: -1470,
    open: -502.5,
    total: -1972.5,
    position: -3,
    maxDrawdown: 2062.5,
  });

  const zeroCost = await request('backtest/run', { ...form, commission: 0, slippage: 0 }, cookie);
  assert.equal(zeroCost.status, 200);
  // Without costs the execution prices equal the opens and the money result has no fees.
  assert.deepEqual(zeroCost.body.executions, [
    { time: start + hour, direction: 'buy', lots: 3, price: 101, commission: 0 },
    { time: start + 2 * hour, direction: 'sell', lots: 6, price: 103, commission: 0 },
  ]);
  assert.deepEqual(zeroCost.body.result, {
    closed: 60,
    open: 270,
    total: 330,
    position: -3,
    maxDrawdown: 90,
  });
});
