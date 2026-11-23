import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JournalEntry } from '../core/journal.js';
import type { OrderIntent } from '../core/robot.js';
import { surfingJournalProjection } from './surfing-journal.js';

test('Surfing journal projection round-trips legacy signals and manual closes', () => {
  const base = {
    id: 'original-id',
    accountId: 'account',
    instrumentUid: 'future',
    ticker: 'F',
    timeframe: '1h',
    direction: 'buy',
    lots: 2,
    fromPosition: 0,
    targetPosition: 2,
  } as const;
  const contexts: OrderIntent['context'][] = [
    {
      type: 'signal',
      candleTime: 1,
      signalTime: 2,
      strategy: { kind: 'surfing', signalPrice: 100, ema: 99 },
    },
    { type: 'manual-close', time: 3 },
  ];
  for (const context of contexts) {
    const persisted = surfingJournalProjection.toJournalIntent({ ...base, context });
    const entry: JournalEntry = {
      ...persisted,
      status: 'reserved',
      brokerOrderId: null,
      brokerStatus: 'unknown',
      executedLots: null,
      executions: [],
      position: null,
    };
    assert.deepEqual(surfingJournalProjection.toRecoveredOrder(entry).context, context);
    assert.equal(surfingJournalProjection.toRecoveredOrder(entry).id, base.id);
  }
  assert.throws(() =>
    surfingJournalProjection.toJournalIntent({
      ...base,
      context: { type: 'signal', candleTime: 1, signalTime: 2, strategy: { kind: 'other' } },
    }),
  );
});
