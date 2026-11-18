import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { OwnerAuth, type SessionStore } from '../core/auth.js';
import { BacktestHistory, type BacktestBroker } from '../core/backtest-history.js';
import { createApp } from './app.js';

const password = 'backtest-test-owner-password';
const hour = 3_600_000;
const start = Date.parse('2026-11-17T21:00:00Z');
const form = { instrumentUid: 'future', emaPeriod: 55, lots: 3, timeframe: '1h', from: '2026-11-18', to: '2026-11-18' };
const candle = (time: number, close: number, complete = true) => ({
  time, open: close, high: close, low: close, close, complete,
});

async function serve(t: TestContext, broker: BacktestBroker, now = start + 25 * hour) {
  const sessions = new Map<string, Date>();
  const store: SessionStore = {
    async create(digest, expiresAt) { sessions.set(digest, expiresAt); },
    async activeUntil(digest) { return sessions.get(digest) ?? null; },
    async revoke(digest) { sessions.delete(digest); },
  };
  const auth = await OwnerAuth.create(password, store);
  const server = createApp({
    auth, secureCookies: false, backtest: new BacktestHistory(broker, async () => 'private-test-token', () => now),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = async (path: string, body?: object, cookie = '') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Serfing-Request': '1', cookie },
      body: body && JSON.stringify(body),
    });
    const payload = await response.text();
    assert.ok(!payload.includes('private-test-token'));
    return { status: response.status, body: JSON.parse(payload), cookie: response.headers.get('set-cookie')?.split(';')[0] };
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
  const candles = [candle(start - hour, 99), candle(start, 101), candle(start + 12 * hour, 103),
    candle(start + 24 * hour, 105)];
  const ema = candles.map(({ time }) => ({ time, value: 100 })).reverse();
  const calls: [number, number][] = [];
  const broker: BacktestBroker = {
    async backtestFuture() {
      return { firstTrade: undefined, lastTrade: undefined, currency: 'rub', priceStep: 1, priceStepAmount: 1, lot: 1 };
    },
    async candles(token, uid, timeframe, from, to) {
      assert.deepEqual([token, uid, timeframe], ['private-test-token', 'future', '1h']);
      calls.push([+from, +to]);
      return candles.filter(({ time }) => time >= +from && time <= +to).reverse();
    },
    async ema(_token, _uid, _timeframe, period, from, to) {
      assert.equal(period, 55);
      return ema.filter(({ time }) => time >= +from && time <= +to);
    },
  };
  return { broker, calls, candles, ema };
}

test('only the owner can check a bounded Moscow period independently of the robot or account', async t => {
  const { broker, calls } = data();
  const { request, authorize } = await serve(t, broker);
  assert.equal((await request('backtest/limits')).status, 401);
  assert.equal((await request('backtest/history', form)).status, 401);
  const cookie = await authorize();
  const { body: limits } = await request('backtest/limits', undefined, cookie);
  assert.equal(limits.maxDays, 7);
  assert.equal(limits.maxEmaPeriod, 1000);
  for (const invalid of [
    { lots: 0 }, { lots: 1.5 }, { emaPeriod: 1001 }, { timeframe: '1m' }, { instrumentUid: '' },
    { from: '2026-11-31' }, { from: '2026-11-19' }, { to: '2026-11-20' },
  ]) assert.equal((await request('backtest/history', { ...form, ...invalid }, cookie)).status, 400);
  const tooLong = await request('backtest/history', { ...form, from: '2026-11-11' }, cookie);
  assert.equal(tooLong.body.code, 'BACKTEST_PERIOD_TOO_LONG');
  assert.equal(calls.length, 0);
  const response = await request('backtest/history', form, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.parameters, form);
  assert.equal(response.body.cutoff, null);
  assert.deepEqual(response.body.candles, [
    { ...candle(start, 101), ema: 100 }, { ...candle(start + 12 * hour, 103), ema: 100 },
  ]);
  assert.equal(calls.at(-1)?.[1], start + 24 * hour);
});

test('overlapping pages do not duplicate candles or bridge a gap in broker data', async t => {
  const { broker, calls, candles, ema } = data();
  const boundary = start + (5 * 24 - 1) * hour;
  candles.push(candle(boundary, 109));
  ema.push({ time: boundary, value: 100 });
  const { request, authorize } = await serve(t, broker, start + 8 * 24 * hour);
  const cookie = await authorize();
  const query = { ...form, to: '2026-11-24' };
  const success = await request('backtest/history', query, cookie);
  assert.equal(success.status, 200);
  assert.equal(success.body.candles.filter((row: { time: number }) => row.time === boundary).length, 1);
  assert.ok(calls.filter(([from, to]) => from <= boundary && boundary <= to).length > 1);

  ema.splice(ema.findIndex(row => row.time === boundary), 1);
  assert.equal((await request('backtest/history', query, cookie)).body.code, 'BACKTEST_EMA_MISSING');
  ema.push({ time: boundary, value: 100 });
  candles.splice(candles.findIndex(row => row.time === boundary), 1);
  assert.equal((await request('backtest/history', query, cookie)).body.code, 'BACKTEST_CANDLES_MISSING');

  candles[0] = candle(start - hour, 100);
  assert.equal((await request('backtest/history', form, cookie)).body.code, 'BACKTEST_BASELINE_MISSING');
  assert.equal((await request('backtest/history', { ...form, from: '2026-11-24', to: '2026-11-24' }, cookie)).body.code,
    'BACKTEST_CANDLES_MISSING');
});

test('an expired contract or conflicting EMA cannot produce a successful check', async t => {
  const { broker } = data();
  const getFuture = broker.backtestFuture;
  broker.backtestFuture = async (...args) => ({ ...await getFuture(...args), lastTrade: new Date(start - hour) });
  const { request, authorize } = await serve(t, broker, start + 8 * 24 * hour);
  const cookie = await authorize();
  const expired = await request('backtest/history', form, cookie);
  assert.equal(expired.status, 422);
  assert.equal(expired.body.code, 'BACKTEST_CONTRACT_PERIOD');

  broker.backtestFuture = getFuture;
  const readEma = broker.ema;
  const overlap = start + (5 * 24 - 1) * hour;
  broker.ema = async (...args) => {
    const points = await readEma(...args);
    const [, , , , from, to] = args;
    if (+from <= overlap && overlap <= +to) points.push({ time: overlap, value: 100 + Number(+from > start) });
    return points;
  };
  const conflict = await request('backtest/history', { ...form, to: '2026-11-24' }, cookie);
  assert.equal(conflict.status, 422);
  assert.equal(conflict.body.code, 'BACKTEST_HISTORY_CONFLICT');
});

test('today reports the effective cutoff and does not treat a forming candle as history', async t => {
  const { broker, candles, ema } = data();
  const current = start + 13 * hour;
  const cutoff = current + hour / 2;
  candles.push(candle(current - 2 * hour, 102, false), candle(current, 104, false));
  ema.push({ time: current, value: 100 }, { time: current - 2 * hour, value: 100 });
  const { request, authorize } = await serve(t, broker, cutoff);
  const cookie = await authorize();
  const incomplete = await request('backtest/history', form, cookie);
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.code, 'BACKTEST_CANDLES_MISSING');
  candles.splice(candles.findIndex(bar => bar.time === current - 2 * hour), 1);
  ema.splice(ema.findIndex(point => point.time === current - 2 * hour), 1);
  const result = await request('backtest/history', form, cookie);
  assert.equal(result.status, 200);
  assert.equal(result.body.cutoff, cutoff);
  assert.deepEqual(result.body.candles.map((bar: { time: number }) => bar.time), [start, start + 12 * hour]);
});
