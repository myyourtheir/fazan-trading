import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideSurfing } from './surfing.js';
import type { Side } from './crossing.js';

test('surfing transitions preserve strict sides across touches and signal only crossings', () => {
  const cases: Array<[Side | null, number, Side | null, number | null]> = [
    [null, 10, null, null],
    [null, 11, 1, null],
    [null, 9, -1, null],
    [1, 10, 1, null],
    [-1, 10, -1, null],
    [1, 11, 1, null],
    [-1, 9, -1, null],
    [-1, 11, 1, 3],
    [1, 9, -1, -3],
  ];
  for (const [side, close, expectedSide, target] of cases) {
    const result = decideSurfing({ side }, { close, ema: 10 }, { lots: 3 });
    assert.deepEqual(result, {
      state: { side: expectedSide },
      signal: target === null ? null : { targetPosition: target, explanation: { close, ema: 10 } },
    });
  }
});

test('non-finite observations never change side or generate a signal', () => {
  for (const observation of [
    { close: 11, ema: NaN },
    { close: Infinity, ema: 10 },
    { close: 9, ema: -Infinity },
  ]) {
    assert.deepEqual(decideSurfing({ side: 1 }, observation, { lots: 3 }), {
      state: { side: 1 },
      signal: null,
    });
  }
});

test('live processing waits for finite broker EMA before making a transition', async () => {
  const { findLiveCrossing } = await import('./crossing.js');
  const hour = 3_600_000;
  const bars = [101, 99, 99].map((close, index) => ({
    time: index * hour,
    open: close,
    high: close,
    low: close,
    close,
    complete: true,
    confirmedEma: index === 1 ? NaN : 100,
    previewEma: 100,
  }));
  const history = {
    instrumentUid: 'future',
    timeframe: '1h' as const,
    emaPeriod: 55,
    candles: bars,
  };
  const options = { since: hour, now: 3 * hour, lastAttempted: -Infinity, lots: 3 };
  assert.equal(findLiveCrossing(history, options), undefined);
  bars[1].confirmedEma = 100;
  assert.equal(findLiveCrossing(history, options)?.targetPosition, -3);
});

test('position delta rejects unpersistable targets and reversals', async () => {
  const { journalPositionDelta } = await import('./position.js');
  for (const [position, target] of [
    [0, NaN],
    [0, 1.5],
    [0, 2_147_483_648],
    [2_147_483_647, -2_147_483_647],
  ]) {
    assert.throws(() => journalPositionDelta(position, target), /unpersistable/);
  }
});

test('live Surfing allows only a target whose full reversal fits the journal', async () => {
  const { canTradeSurfing } = await import('./surfing-strategy.js');
  assert.equal(canTradeSurfing({ lots: 1_073_741_823 }), true);
  assert.equal(canTradeSurfing({ lots: 1_073_741_824 }), false);
});
