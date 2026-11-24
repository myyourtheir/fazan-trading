import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  addOnDue,
  entryLots,
  gapAgainstPosition,
  initialIndicators,
  observeCompleted,
  openImprovedPosition,
  trailStop,
} from './improved-surfing.js';
import { improvedDefaults } from './strategy-settings.js';

test('Wilder ATR uses previous close and crossings require confirmed EMA', () => {
  let state = initialIndicators();
  const observe = (high: number, low: number, close: number, confirmedEma: number | null) => {
    const result = observeCompleted(state, { time: 0, high, low, close, confirmedEma }, 2);
    state = result.state;
    return result.crossing;
  };
  assert.equal(observe(11, 9, 10, 11), null);
  assert.equal(state.atr, null);
  assert.equal(observe(14, 12, 13, 12), 1);
  assert.equal(state.atr, null);
  assert.equal(observe(15, 13, 14, 14), null);
  assert.equal(state.atr, 3);
  assert.equal(observe(17, 15, 16, null), null);
  assert.equal(state.atr, 3);
  assert.equal(observe(14, 12, 13, 14), null);
});

test('size, fixed add thresholds, and monotonic trailing work in both directions', () => {
  const p = improvedDefaults;
  assert.equal(entryLots(1000, 100, 2), 4);
  assert.equal(entryLots(100, 100, 2), 0);
  assert.equal(entryLots(Infinity, 100, 2), 0);
  for (const side of [1, -1] as const) {
    const position = openImprovedPosition(side, 100, 2, 4, p);
    assert.equal(position.stop, 100 - side * 4);
    assert.equal(addOnDue(position, 100 + side, p), false);
    assert.equal(addOnDue(position, 100 + side * 2, p), true);
    assert.equal(addOnDue({ ...position, addOns: 1 }, 100 + side * 3, p), false);
    assert.equal(addOnDue({ ...position, addOns: 3 }, 100 + side * 20, p), false);
    const trailed = trailStop(position, 100 + side * 10, 2, p);
    assert.equal(trailed.stop, 100 + side * 6);
    assert.equal(trailStop(trailed, 100 + side * 11, 10, p).stop, trailed.stop);
    assert.equal(trailStop(trailed, 100 + side * 9, 1, p), trailed);
    assert.equal(gapAgainstPosition(side, 100 - side, 100), true);
    assert.equal(gapAgainstPosition(side, 100, 100), false);
  }
});
