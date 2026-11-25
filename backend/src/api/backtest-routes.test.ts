import { surfingBacktest } from '../core/surfing-backtest.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { OwnerAuth, type SessionStore } from '../core/auth.js';
import { BacktestHistory, type BacktestBroker } from '../core/backtest-history.js';
import { DisplaySettings } from '../core/display-settings.js';
import { HistoricalBacktest } from '../core/historical-backtest.js';
import {
  historicalBar,
  historicalFixture,
  historyStart,
  improvedRun,
  moscowMidnight,
} from '../core/historical-backtest.test-support.js';
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

async function serve(
  t: TestContext,
  broker: BacktestBroker,
  now = start + 25 * hour,
  historicalBacktest?: HistoricalBacktest,
) {
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
    historicalBacktest,
    backtest: new BacktestHistory(
      broker,
      async () => 'private-test-token',
      () => now,
      surfingBacktest,
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

test('explicit strategies run strict Moscow history with cost defaults, never the legacy fallback', async (t) => {
  const fixture = historicalFixture([
    historicalBar(moscowMidnight - 2 * hour, 101),
    historicalBar(moscowMidnight - hour, 99),
    historicalBar(historyStart, 99, 101),
    historicalBar(historyStart + hour, 101),
  ]);
  const { request, authorize } = await serve(t, data().broker, undefined, fixture.backtest);
  const {
    initialMoney: _money,
    commission: _commission,
    slippage: _slippage,
    ...draft
  } = improvedRun;
  assert.equal((await request('backtest/run', draft)).status, 401);
  const cookie = await authorize();
  await request('settings/display', { timeZone: 'America/New_York' }, cookie, 'PUT');
  const response = await request('backtest/run', draft, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.parameters, {
    ...draft,
    timeZone: 'Europe/Moscow',
    initialMoney: 100_000,
    commission: 0,
    slippage: 0,
  });
  assert.equal(response.body.executions[0].reason, 'entry');
  const surf = { ...form, instrumentUid: draft.instrumentUid, emaPeriod: 2, kind: 'surfing' };
  const other = await request('backtest/run', surf, cookie);
  assert.equal(other.status, 200);
  assert.equal(other.body.executions[0].lots, form.lots);
  for (const invalid of [
    { kind: 'another' },
    { atrPeriod: 0 },
    { tradeWeekends: 'false' },
    { slippage: 0.5 },
    { initialMoney: 0 },
    { initialMoney: null },
    { commission: 101 },
  ])
    assert.equal((await request('backtest/run', { ...draft, ...invalid }, cookie)).status, 400);
  fixture.minutes.splice(
    fixture.minutes.findIndex(({ time }) => time === historyStart),
    60,
  );
  const partial = await request('backtest/run', surf, cookie);
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body.coverage.excludedIntervals, [historyStart]);
});

test('unconfirmed minute buckets are excluded without treating silence in both feeds as missing data', async (t) => {
  const at = (hours: number) => historyStart + hours * hour;
  const fixture = historicalFixture([
    historicalBar(moscowMidnight - 2 * hour, 101),
    historicalBar(moscowMidnight - hour, 99),
    historicalBar(at(0), 99, 101),
    historicalBar(at(1), 101),
    historicalBar(at(2), 101),
    historicalBar(at(4), 101),
    historicalBar(at(5), 101),
    historicalBar(at(6), 101),
    historicalBar(at(7), 101),
  ]);
  // Missing minute bucket, missing strategy bucket, mismatched OHLC, and one harmless minute hole.
  fixture.minutes.splice(
    fixture.minutes.findIndex(({ time }) => time === at(1)),
    60,
  );
  fixture.candles.splice(
    fixture.candles.findIndex(({ time }) => time === at(4)),
    1,
  );
  fixture.minutes.find(({ time }) => time === at(5))!.high += 10;
  fixture.minutes.splice(
    fixture.minutes.findIndex(({ time }) => time === at(7) + 60_000),
    1,
  );
  const { request, authorize } = await serve(t, data().broker, undefined, fixture.backtest);
  const cookie = await authorize();
  const surf = { ...form, instrumentUid: improvedRun.instrumentUid, emaPeriod: 2, kind: 'surfing' };
  for (const draft of [surf, improvedRun]) {
    for (const operation of ['history', 'run']) {
      const response = await request(`backtest/${operation}`, draft, cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.coverage.excludedIntervals, [at(1), at(4), at(5)]);
      assert.deepEqual(
        response.body.candles.map((bar: { time: number }) => bar.time),
        [at(0), at(2), at(6), at(7)],
      );
      assert.deepEqual(response.body.coverage.actual, { from: at(0), to: at(7) });
      assert.equal(response.body.coverage.uncoveredStart, false);
      assert.equal(response.body.coverage.uncoveredEnd, false);
      if (operation === 'run') {
        assert.equal(response.body.model.missingMinutes, 1);
        assert.deepEqual(response.body.executions, []);
      }
    }
  }
  fixture.minutes.length = 0;
  assert.equal(
    (await request('backtest/run', surf, cookie)).body.code,
    'BACKTEST_NO_CONFIRMED_INTERVALS',
  );
});

test('improved surfing protects on the first confirmed price after an excluded bucket', async (t) => {
  const fixture = historicalFixture([
    historicalBar(moscowMidnight - 2 * hour, 101),
    historicalBar(moscowMidnight - hour, 99),
    historicalBar(historyStart, 99, 101),
    historicalBar(historyStart + hour, 101, 102),
    historicalBar(historyStart + 2 * hour, 80),
    historicalBar(historyStart + 3 * hour, 98, 99),
  ]);
  fixture.minutes.find(({ time }) => time === historyStart + 2 * hour)!.high += 10;
  const { request, authorize } = await serve(t, data().broker, undefined, fixture.backtest);
  const response = await request('backtest/run', improvedRun, await authorize());
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.executions.map(
      ({ time, reason, price }: { time: number; reason: string; price: number }) => [
        time,
        reason,
        price,
      ],
    ),
    [
      [historyStart + hour, 'entry', 101],
      [historyStart + 3 * hour, 'gap', 98],
    ],
  );
});

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
    async backtestCandles(token, uid, timeframe, from, to) {
      assert.deepEqual([token, uid, timeframe], ['private-test-token', 'future', '1h']);
      calls.push([+from, +to]);
      return candles.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
  };
  return { broker, calls, candles };
}

test('only the owner can check a Moscow period independently of the robot or account', async (t) => {
  const { broker, calls } = data();
  const { request, authorize } = await serve(t, broker);
  assert.equal((await request('backtest/limits')).status, 401);
  assert.equal((await request('backtest/history', form)).status, 401);
  const cookie = await authorize();
  const { body: limits } = await request('backtest/limits', undefined, cookie);
  assert.deepEqual(limits, { maxEmaPeriod: 1000 });
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

test('all three backtests load more than 30 days in broker-sized pages and carry local EMA across pages', async (t) => {
  const day = 24 * hour;
  const first = start - 34 * day;
  const selected = [candle(first, 110), candle(first + 6 * day - hour, 90), candle(start, 120)];
  const bars = [
    candle(first - 3 * hour, 200),
    candle(first - 2 * hour, 102),
    candle(first - hour, 98),
    ...selected,
  ];
  const { broker } = data();
  const market = {
    backtestFuture: broker.backtestFuture,
    async backtestCandles(_token: string, _uid: string, _timeframe: string, from: Date, to: Date) {
      assert.ok(+to - +from <= 7 * day);
      return bars.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
    async minuteCandles(_token: string, _uid: string, from: Date, to: Date) {
      assert.ok(+to - +from <= day);
      return bars.filter(({ time }) => time >= +from && time <= +to);
    },
  };
  const historical = new HistoricalBacktest(
    market,
    async () => 'test',
    () => start + 25 * hour,
  );
  const { request, authorize } = await serve(t, market, undefined, historical);
  const cookie = await authorize();
  const query = { ...form, emaPeriod: 2, from: '2026-10-15' };
  const expected = [106 + 2 / 3, 95 + 5 / 9, 111 + 23 / 27];
  for (const draft of [
    query,
    { ...query, kind: 'surfing' },
    { ...improvedRun, ...query, atrPeriod: 2 },
  ]) {
    for (const endpoint of ['history', 'run']) {
      const response = await request(`backtest/${endpoint}`, draft, cookie);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.emaSource, 'local');
      assert.deepEqual(
        response.body.candles.map((bar: { time: number }) => bar.time),
        selected.map(({ time }) => time),
      );
      for (const [index, ema] of expected.entries()) {
        assert.ok(Math.abs(response.body.candles[index].ema - ema) < 1e-10);
      }
    }
  }
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
    'BACKTEST_HISTORY_EMPTY',
  );
});

test('an expired contract has no candles and conflicting duplicates cannot produce a successful check', async (t) => {
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
  assert.equal(expired.body.code, 'BACKTEST_HISTORY_EMPTY');

  broker.backtestFuture = getFuture;
  const readCandles = broker.backtestCandles;
  const overlap = start + (6 * 24 - 1) * hour;
  broker.backtestCandles = async (...args) => {
    const bars = await readCandles(...args);
    const [, , , from, to] = args;
    if (+from <= overlap && overlap <= +to) bars.push(candle(overlap, 100 + Number(+from > start)));
    return bars;
  };
  const conflict = await request('backtest/history', { ...form, to: '2026-11-24' }, cookie);
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.code, 'BACKTEST_HISTORY_CONFLICT');
});

test('all modes report the available overlap and distinguish empty, unusable and failed history', async (t) => {
  const day = 24 * hour;
  const prior = [candle(start - 2 * hour, 102), candle(start - hour, 98)];
  const selected = [candle(start + day + hour, 110), candle(start + 2 * day + hour, 90)];
  let outcome: 'partial' | 'empty' | 'invalid' | 'undated' | 'failed' | 'minutesFailed' = 'partial';
  const market = {
    async backtestFuture() {
      return {
        firstTrade: new Date(start - day),
        lastTrade: new Date(start + 7 * day),
        priceStep: 1,
        priceStepAmount: 1,
        currency: 'rub',
        lot: 1,
      };
    },
    async backtestCandles(_token: string, uid: string, _timeframe: string, from: Date, to: Date) {
      assert.equal(uid, 'future');
      assert.ok(+from >= start - day && +to <= start + 8 * day);
      if (outcome === 'failed' && +from >= start + 4 * day) throw new Error('broker unavailable');
      if (outcome === 'undated') return [null];
      const rows = outcome === 'empty' ? prior : [...prior, ...selected];
      return rows
        .filter(({ time }) => time >= +from && time <= +to)
        .map((bar) =>
          outcome === 'invalid' && bar.time >= start ? { ...bar, complete: false } : bar,
        );
    },
    async minuteCandles(_token: string, _uid: string, from: Date, to: Date) {
      if (outcome === 'minutesFailed' && +from >= start + 4 * day)
        throw new Error('broker unavailable');
      return outcome === 'empty' || outcome === 'undated'
        ? []
        : [...prior, ...selected].filter(({ time }) => time >= +from && time <= +to);
    },
  };
  const now = start + 12 * day;
  const { request, authorize } = await serve(
    t,
    market,
    now,
    new HistoricalBacktest(
      market,
      async () => 'test',
      () => now,
    ),
  );
  const cookie = await authorize();
  const query = { ...form, emaPeriod: 2, to: '2026-11-28' };
  for (const draft of [query, { ...query, kind: 'surfing' }, { ...improvedRun, ...query }]) {
    for (const operation of ['history', 'run']) {
      outcome = 'partial';
      const run = () => request(`backtest/${operation}`, draft, cookie);
      const result = await run();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.parameters.from, query.from);
      assert.equal(result.body.parameters.to, query.to);
      assert.deepEqual(result.body.coverage, {
        requested: { from: query.from, to: query.to },
        actual: { from: selected[0].time, to: selected[1].time },
        uncoveredStart: true,
        uncoveredEnd: true,
      });
      for (const [next, status, code] of [
        ['empty', 422, 'BACKTEST_HISTORY_EMPTY'],
        [
          'invalid',
          422,
          'kind' in draft ? 'BACKTEST_NO_CONFIRMED_INTERVALS' : 'BACKTEST_CANDLES_MISSING',
        ],
        [
          'undated',
          422,
          'kind' in draft ? 'BACKTEST_NO_CONFIRMED_INTERVALS' : 'BACKTEST_CANDLES_MISSING',
        ],
        ['failed', 502, 'BACKTEST_CANDLES_LOAD_FAILED'],
      ] as const) {
        outcome = next;
        const failure = await run();
        assert.equal(failure.status, status);
        assert.equal(failure.body.code, code);
      }
      if ('kind' in draft) {
        outcome = 'minutesFailed';
        const failure = await run();
        assert.equal(failure.status, 502);
        assert.equal(failure.body.code, 'BACKTEST_CANDLES_LOAD_FAILED');
      }
    }
  }
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

test('all modes can warm up within the contract overlap, and improved surfing waits for ATR', async (t) => {
  const at = (index: number) => start + index * hour;
  const bars = [100, 90, 110, 95, 105, 106].map((close, index) => candle(at(index), close));
  let count = bars.length;
  const { broker } = data();
  const market = {
    async backtestFuture(...args: Parameters<BacktestBroker['backtestFuture']>) {
      return { ...(await broker.backtestFuture(...args)), firstTrade: new Date(start) };
    },
    async backtestCandles(_token: string, _uid: string, _timeframe: string, from: Date, to: Date) {
      assert.ok(+from >= start);
      return bars.slice(0, count).filter(({ time }) => time >= +from && time <= +to);
    },
    async minuteCandles(_token: string, _uid: string, from: Date, to: Date) {
      return bars.slice(0, count).filter(({ time }) => time >= +from && time <= +to);
    },
  };
  const now = start + 25 * hour;
  const { request, authorize } = await serve(
    t,
    market,
    now,
    new HistoricalBacktest(
      market,
      async () => 'test',
      () => now,
    ),
  );
  const cookie = await authorize();
  const query = { ...form, emaPeriod: 2, from: '2026-11-17' };
  for (const [draft, required, firstExecution] of [
    [query, 2, at(3)],
    [{ ...query, kind: 'surfing' }, 2, at(3)],
    [{ ...improvedRun, ...query, atrPeriod: 3 }, 4, at(4)],
  ] as const) {
    count = bars.length;
    for (const operation of ['history', 'run']) {
      const response = await request(`backtest/${operation}`, draft, cookie);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.coverage.actual, { from: at(0), to: at(5) });
      assert.equal(response.body.coverage.readyAt, at(required));
      assert.equal(response.body.candles[0].ema, null);
      assert.equal(response.body.candles[1].ema, 95);
      if (operation === 'run') assert.equal(response.body.executions[0].time, firstExecution);
    }
    count = required;
    const ready = await request('backtest/run', draft, cookie);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.deepEqual(ready.body.executions, []);
    assert.equal(ready.body.finalSignal ?? null, null);
    count = required - 1;
    for (const operation of ['history', 'run']) {
      const notReady = await request(`backtest/${operation}`, draft, cookie);
      assert.equal(notReady.status, 422);
      assert.deepEqual(notReady.body, {
        code: 'BACKTEST_WARMUP_MISSING',
        details: { required, available: count, searchedFrom: '2026-11-18' },
      });
    }
  }
});

test('when pre-range EMA is ready sooner than ATR its state continues into the in-range warmup', async (t) => {
  const fixture = historicalFixture([
    historicalBar(moscowMidnight - 2 * hour, 110),
    historicalBar(moscowMidnight - hour, 90),
    historicalBar(historyStart, 115),
    historicalBar(historyStart + hour, 119),
  ]);
  const { request, authorize } = await serve(t, data().broker, undefined, fixture.backtest);
  const response = await request(
    'backtest/run',
    { ...improvedRun, atrPeriod: 3 },
    await authorize(),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.coverage.readyAt, historyStart + 2 * hour);
  assert.deepEqual(
    response.body.candles.map(({ ema }: { ema: number }) => ema),
    [110, 116],
  );
  assert.deepEqual(response.body.executions, []);
});

test('unconfirmed pre-range candles cannot seed EMA in the minute-based backtest', async (t) => {
  const fixture = historicalFixture([
    historicalBar(moscowMidnight - 2 * hour, 500),
    historicalBar(moscowMidnight - hour, 400),
    historicalBar(historyStart, 90),
    historicalBar(historyStart + hour, 110),
  ]);
  fixture.minutes.splice(
    0,
    fixture.minutes.findIndex(({ time }) => time === historyStart),
  );
  const { request, authorize } = await serve(t, data().broker, undefined, fixture.backtest);
  const response = await request(
    'backtest/run',
    { ...form, kind: 'surfing', instrumentUid: improvedRun.instrumentUid, emaPeriod: 2 },
    await authorize(),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.coverage.readyAt, historyStart + 2 * hour);
  assert.deepEqual(
    response.body.candles.map(({ ema }: { ema: number | null }) => ema),
    [null, 100],
  );
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
    details: { required: 55, available: 50, searchedFrom: '2026-11-16' },
  });
  assert.equal(Math.min(...calls.map(([from]) => from)), start - 48 * hour);

  broker.backtestFuture = getFuture;
  calls.length = 0;
  const bounded = await request('backtest/history', { ...form, emaPeriod: 1000 }, cookie);
  assert.equal(bounded.status, 422);
  assert.deepEqual(bounded.body, {
    code: 'BACKTEST_WARMUP_MISSING',
    details: { required: 1000, available: 58, searchedFrom: '2025-11-18' },
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
    async backtestCandles(_token, _uid, _timeframe, from, to) {
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
  broker.backtestCandles = async (_token, _uid, _timeframe, from, to) =>
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
    async backtestCandles(_token, _uid, _timeframe, from, to) {
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
