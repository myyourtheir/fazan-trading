import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { defineStrategy } from './strategy.js';
import type { MarketCandle } from './market-data.js';
import { Robot, type FeedUpdate, type TradingConfig, type TradingStore } from './robot.js';
import { BacktestHistory } from './backtest-history.js';
import type { BacktestBaseParameters } from './backtest.js';

const hour = 3_600_000;
const start = Date.parse('2026-11-18T00:00:00Z');
type Params = { threshold: number };
type Config = TradingConfig & Params;
type History = { instrumentUid: string; timeframe: Config['timeframe']; candles: MarketCandle[] };
type BackParams = BacktestBaseParameters & Params;
const decide = (state: number, candle: MarketCandle, parameters: Params) => ({
  state: state + 1,
  signal:
    candle.close > parameters.threshold
      ? { targetPosition: 2, explanation: { close: candle.close } }
      : null,
});
const decisions: {
  state: number;
  candle: MarketCandle;
  parameters: Params;
  result: ReturnType<typeof decide>;
}[] = [];
const definition = defineStrategy<
  'threshold',
  Params,
  number,
  MarketCandle,
  { close: number },
  Config,
  BackParams,
  MarketCandle,
  number,
  History
>({
  kind: 'threshold',
  validate: (value): value is Params =>
    typeof value === 'object' &&
    value !== null &&
    'threshold' in value &&
    typeof value.threshold === 'number',
  decide(state, candle, parameters) {
    const result = decide(state, candle, parameters);
    const { time, open, high, low, close, complete } = candle;
    decisions.push({
      state,
      candle: { time, open, high, low, close, complete },
      parameters: { threshold: parameters.threshold },
      result,
    });
    return result;
  },
  live: (decide) => (history, options, config) => {
    let state = 0;
    for (const candle of history.candles) {
      if (!candle.complete || candle.time + hour > options.now) continue;
      const result = decide(state, candle, config);
      state = result.state;
      if (
        result.signal &&
        candle.time + hour > options.since &&
        candle.time > options.lastAttempted
      ) {
        return {
          candleTime: candle.time,
          signalTime: candle.time + hour,
          targetPosition: result.signal.targetPosition,
          strategy: { kind: 'threshold', ...result.signal.explanation },
        };
      }
    }
  },
  backtest: (decide) => ({
    warmupCount: () => 0,
    prepare: (_parameters, candles) => ({ candles, initialState: 0 }),
    decide,
  }),
});
const bar = (time: number, close: number): MarketCandle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  complete: true,
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await delay(5);
  assert.ok(check(), 'expected asynchronous update');
}

test('one non-EMA definition drives actual live reconnect and public backtest', async (t) => {
  assert.equal(definition.validate({ threshold: 100 }), true);
  assert.equal(definition.validate({ threshold: '100' }), false);
  let now = start + hour + 1;
  let bars = [bar(start, 90)];
  let listener: ((update: FeedUpdate<History>) => void) | undefined;
  const market = {
    async subscribe(callback: (update: FeedUpdate<History>) => void, pinned: Config) {
      assert.deepEqual(pinned, config);
      listener = callback;
      callback({ stream: 'live', history: { instrumentUid: 'f', timeframe: '1h', candles: bars } });
      return () => {
        listener = undefined;
      };
    },
  };
  const config: Config = {
    token: 'fake',
    accountId: 'a',
    ticker: 'F',
    instrumentUid: 'f',
    timeframe: '1h',
    threshold: 100,
  };
  const orders: number[] = [];
  const recorded: string[] = [];
  const store: TradingStore = {
    async reserve(order) {
      orders.push(order.targetPosition);
      return true;
    },
    async record(_id, result) {
      recorded.push(result.status);
    },
    async hasUnresolved() {
      return false;
    },
    async unresolved() {
      return null;
    },
    async history() {
      return [];
    },
  };
  let position = 0;
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        return { position, activeOrders: false };
      },
      async submit(_token, order) {
        position = order.targetPosition;
        return { brokerOrderId: 'id', brokerStatus: 'filled', executedLots: order.lots };
      },
      async orderState() {
        return {
          brokerOrderId: 'id',
          brokerStatus: 'filled',
          executedLots: 2,
          executions: [{ tradeId: 'fill', lots: 2, price: 120, time: now }],
        };
      },
    },
    store,
    market,
    async () => config,
    () => now,
    definition.live,
  );
  t.after(() => robot.shutdown());
  await robot.start();
  await until(() => robot.status().mode === 'running');
  now = start + 2 * hour + 1;
  bars = [bar(start, 90), bar(start + hour, 110)];
  listener?.({ stream: 'disconnected' });
  listener?.({
    stream: 'live',
    recoveredAt: now,
    history: { instrumentUid: 'f', timeframe: '1h', candles: bars },
  });
  assert.equal(robot.status().mode, 'running');
  assert.deepEqual(orders, [], 'recovery history must never trade');
  now = start + 3 * hour + 1;
  bars = [...bars, bar(start + 2 * hour, 120)];
  listener?.({ stream: 'live', history: { instrumentUid: 'f', timeframe: '1h', candles: bars } });
  await until(() => recorded.includes('confirmed'));
  assert.deepEqual(orders, [2]);
  assert.equal(position, 2);
  assert.equal(robot.status().mode, 'running');
  const liveDecision = decisions.findLast((entry) => entry.candle.time === start + 2 * hour);
  assert.ok(liveDecision?.result.signal);
  decisions.length = 0;
  const backtest = new BacktestHistory(
    {
      async backtestCandles() {
        return bars;
      },
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
    },
    async () => 'fake',
    () => start + 86_400_000,
    definition.backtest,
  );
  const report = await backtest.run({
    instrumentUid: 'f',
    timeframe: '1h',
    threshold: 100,
    from: '2026-11-18',
    to: '2026-11-18',
    timeZone: 'UTC',
    commission: 0,
    slippage: 0,
  });
  assert.equal(report.executions[0].time, start + 2 * hour);
  assert.equal(report.executions[0].lots, 2);
  const backtestDecision = decisions.find((entry) => entry.candle.time === start + 2 * hour);
  assert.deepEqual(backtestDecision, liveDecision);
  assert.deepEqual(orders, [2], 'backtest must not trade live');
});
