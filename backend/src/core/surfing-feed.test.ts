import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketUpdate } from './market-data.js';
import { surfingFeed } from './surfing-feed.js';

test('surfing feed pins and filters the EMA selection', async () => {
  const config = {
    token: 'fake',
    accountId: 'account',
    ticker: 'F',
    instrumentUid: 'future',
    timeframe: '1h' as const,
    emaPeriod: 55,
  };
  const received: MarketUpdate[] = [];
  let emit: (update: MarketUpdate) => void = () => {};
  let unsubscribed = false;
  const feed = surfingFeed({
    async subscribe(listener, pinned) {
      assert.deepEqual(pinned, config);
      emit = listener;
      return () => {
        unsubscribed = true;
      };
    },
  });
  const unsubscribe = await feed.subscribe((update) => received.push(update), config);
  emit({ stream: 'live', history: { ...config, emaPeriod: 3, candles: [] } });
  emit({ stream: 'live', history: { ...config, candles: [] } });
  assert.equal(received.length, 1);
  assert.equal(received[0].history?.emaPeriod, 55);
  unsubscribe();
  assert.equal(unsubscribed, true);
});
