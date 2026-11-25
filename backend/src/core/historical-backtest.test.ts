import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FullBacktestParameters } from './historical-backtest.js';
import {
  historicalBar as bar,
  historicalFixture,
  historyEnd,
  historyStart as start,
  improvedRun,
  moscowMidnight,
} from './historical-backtest.test-support.js';
import { timeframeMs } from './timeframe.js';

const hour = timeframeMs['1h'];
const warmup = [bar(moscowMidnight - 2 * hour, 97), bar(moscowMidnight - hour, 99)];
const cross = bar(start, 99, 101);
const surfing: FullBacktestParameters = {
  kind: 'surfing',
  instrumentUid: 'instrument',
  timeframe: '1h',
  emaPeriod: 1,
  lots: 2,
  from: '2026-11-18',
  to: '2026-11-18',
  initialMoney: 1000,
  commission: 0.1,
  slippage: 2,
};

test('Surfing uses broker EMA and fills a reversal in two legs, keeping the final short open', async () => {
  const { backtest, calls } = historicalFixture([
    ...warmup,
    cross,
    bar(start + hour, 102, 99),
    bar(start + 2 * hour, 98, 97),
  ]);
  const report = await backtest.run(surfing);
  assert.deepEqual(calls.minutes, [[moscowMidnight, historyEnd]]);
  assert.deepEqual(
    report.candles.map(({ time, ema }) => [time, ema]),
    [
      [start, 100],
      [start + hour, 100],
      [start + 2 * hour, 100],
    ],
  );
  assert.deepEqual(
    report.executions.map((execution) => ({
      ...execution,
      commission: Number(execution.commission.toFixed(3)),
    })),
    [
      {
        time: start + hour,
        direction: 'buy',
        price: 103,
        lots: 2,
        commission: 0.206,
        reason: 'entry',
      },
      {
        time: start + 2 * hour,
        direction: 'sell',
        price: 97,
        lots: 2,
        commission: 0.194,
        reason: 'reversal-exit',
      },
      {
        time: start + 2 * hour,
        direction: 'sell',
        price: 97,
        lots: 2,
        commission: 0.194,
        reason: 'reversal-entry',
      },
    ],
  );
  assert.equal(report.result.position, -2);
  assert.deepEqual(report.model, { missingMinutes: 0, marginPerLotAtClose: 97 });
  assert.equal(report.result.closed, -12.4);
  assert.equal(report.result.open, -0.194);
  assert.equal(report.result.commission.toFixed(3), '0.594');
  assert.equal(report.result.returnPercent.toFixed(4), '-1.2594');
  assert.ok(report.result.maxDrawdown > 0);
  assert.deepEqual(report.equity[0], { time: moscowMidnight, value: 1000 });
  assert.equal(report.equity.at(-1)?.value.toFixed(3), '987.406');
});

test('a signal at session end is dropped, and no position is opened by warm-up', async () => {
  const { backtest } = historicalFixture([...warmup, cross, bar(start + 2 * hour, 105)]);
  for (const draft of [surfing, improvedRun]) {
    const report = await backtest.run(draft);
    assert.deepEqual(report.executions, []);
    assert.equal(report.result.total, 0);
  }
});

test('an entirely empty broker range is not reported as a confirmed closed day', async () => {
  const { backtest } = historicalFixture(warmup);
  await assert.rejects(backtest.run(improvedRun), { code: 'BACKTEST_CANDLES_MISSING' });
});

test('a minute hole inside an observed session is counted and execution uses the next observed price', async () => {
  const { backtest, minutes } = historicalFixture([...warmup, cross, bar(start + hour, 101)]);
  const opening = minutes.findIndex(({ time }) => time === start + hour);
  const first = minutes[opening];
  minutes[opening + 1] = { ...first, time: first.time + 60_000 };
  minutes.splice(opening, 1);
  const report = await backtest.run(improvedRun);
  assert.equal(report.model.missingMinutes, 1);
  assert.equal(report.executions[0].time, start + hour + 60_000);
});

test('the stop fills at the level on a minute touch; slippage worsens both fills', async () => {
  const { backtest, minutes } = historicalFixture([
    ...warmup,
    cross,
    bar(start + hour, 101, 100, 93, 102),
  ]);
  const first = minutes.find((bar) => bar.time === start + hour)!;
  const trough = minutes.find((bar) => bar.time === start + hour + 9 * 60_000)!;
  first.low = 100;
  trough.low = 93; // Stop = 101 - 2 * 4. No strategy-bar-close approximation.
  const report = await backtest.run({ ...improvedRun, slippage: 1 });
  assert.deepEqual(
    report.executions.map(({ reason, time, price }) => [reason, time, price]),
    [
      ['entry', start + hour, 101.5],
      ['stop', start + hour + 9 * 60_000, 92.5],
    ],
  );
  assert.equal(report.result.position, 0);
});

test('a stop skipped at the opening wins over a simultaneous adverse gap', async () => {
  const { backtest } = historicalFixture([
    ...warmup,
    cross,
    bar(start + hour, 101, 102),
    bar(start + 2 * hour, 90, 105),
    bar(start + 3 * hour, 105, 105),
  ]);
  const report = await backtest.run({ ...improvedRun, slippage: 1 });
  assert.deepEqual(
    report.executions.map(({ reason, price, lots }) => [reason, price, lots]),
    [
      ['entry', 101.5, 8],
      ['stop', 89.5, 8],
    ],
  );
});

test('trailing protection uses only completed closes and never gives back a better level', async () => {
  const { backtest } = historicalFixture([
    ...warmup,
    cross,
    bar(start + hour, 101, 110),
    bar(start + 2 * hour, 110, 112, 109, 113),
    bar(start + 3 * hour, 112, 113, 110, 129), // An enormous ATR cannot lower the stop at 104.
    bar(start + 4 * hour, 112, 110, 104, 114),
  ]);
  const report = await backtest.run({ ...improvedRun, maxAddOns: 0 });
  assert.deepEqual(
    report.executions.map(({ reason, price }) => [reason, price]),
    [
      ['entry', 101],
      ['stop', 104],
    ],
  );
});

test('a range including the still-running Moscow day is rejected before any history request', async () => {
  const { backtest, calls } = historicalFixture(warmup);
  await assert.rejects(backtest.run({ ...improvedRun, to: '2026-11-19' }), {
    code: 'BACKTEST_PERIOD_UNFINISHED',
  });
  assert.deepEqual(calls, { minutes: [] });
});

test('a rejected add-on neither resizes nor consumes the threshold', async () => {
  const { backtest } = historicalFixture(
    [
      ...warmup,
      cross,
      bar(start + hour, 100, 106),
      bar(start + 2 * hour, 106, 106),
      bar(start + 3 * hour, 100, 101),
    ],
    { pointValue: 1.7 },
  );
  // The 10-lot position requires ₽1,060 at the first attempt (equity ₽1,051), then ₽1,000.
  const report = await backtest.run(improvedRun);
  assert.deepEqual(
    report.executions.map(({ reason, time, lots }) => [reason, time, lots]),
    [
      ['entry', start + hour, 5],
      ['add-on', start + 3 * hour, 5],
    ],
  );
  assert.equal(report.result.position, 10);
});

test('the weekend switch suppresses new openings but not protective exits', async () => {
  const thursday = start + 24 * hour;
  const friday = thursday + 24 * hour;
  const saturday = friday + 24 * hour;
  const { backtest } = historicalFixture(
    [
      bar(thursday, 97),
      bar(thursday + hour, 99),
      bar(friday, 99, 101),
      bar(friday + hour, 101, 102),
      bar(saturday, 99, 97),
      bar(saturday + hour, 98, 101),
      bar(saturday + 2 * hour, 102),
    ],
    { now: historyEnd + 3 * 24 * hour },
  );
  const draft = { ...improvedRun, from: '2026-11-20', to: '2026-11-21' };
  assert.deepEqual(
    (await backtest.run(draft)).executions.map(({ reason }) => reason),
    ['entry', 'gap'],
  );
  assert.deepEqual(
    (await backtest.run({ ...draft, tradeWeekends: true })).executions.map(({ reason }) => reason),
    ['entry', 'gap', 'entry'],
  );
});

test('coverage failures are explicit and never fall back to locally computed EMA or coarser stops', async (t) => {
  for (const [code, corrupt] of Object.entries({
    BACKTEST_EMA_MISSING: (fixture) => fixture.ema.shift(),
    BACKTEST_MINUTES_MISSING: (fixture) => fixture.minutes.splice(0, 60),
    BACKTEST_CANDLES_MISSING: (fixture) => fixture.candles.pop(),
    BACKTEST_WARMUP_MISSING: (fixture) => fixture.candles.shift(),
    BACKTEST_HISTORY_CONFLICT: (fixture) => {
      fixture.minutes[1].high += 100;
    },
  } satisfies Record<string, (fixture: ReturnType<typeof historicalFixture>) => unknown>)) {
    await t.test(code, async () => {
      const fixture = historicalFixture([...warmup, cross, bar(start + hour, 101)]);
      corrupt(fixture);
      await assert.rejects(fixture.backtest.run(improvedRun), { code });
    });
  }
});
