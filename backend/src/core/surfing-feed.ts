import { sameMarketSelection, type MarketData } from './market-data.js';
import type { TradingConfig } from './robot.js';

// Pin the indicator selection to this run; unrelated chart feeds cannot drive trading.
export function surfingFeed(market: Pick<MarketData, 'subscribe'>) {
  return {
    subscribe(
      listener: Parameters<MarketData['subscribe']>[0],
      config: TradingConfig & { emaPeriod: number },
    ) {
      return market.subscribe((update) => {
        if (update.history && !sameMarketSelection(update.history, config)) return;
        listener(update);
      }, config);
    },
  };
}
