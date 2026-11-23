import type { FutureContract, SandboxConnection } from './sandbox.js';
import { defaultTimeframe, type Timeframe } from './timeframe.js';
import { isTimeframe } from './timeframe.js';
import { surfingStrategy } from './surfing-strategy.js';

const defaults = { ticker: 'IMOEXF', emaPeriod: 55, timeframe: defaultTimeframe } as const;

export type SavedStrategy = {
  instrument: FutureContract;
  timeframe: Timeframe;
  kind: 'surfing';
  parameters: { emaPeriod: number; lots: number };
};

export interface StrategyStore {
  load(): Promise<SavedStrategy | null>;
  save(settings: SavedStrategy): Promise<void>;
}

export class StrategySettings {
  constructor(
    private readonly store: StrategyStore,
    private readonly sandbox: SandboxConnection,
  ) {}

  public async get() {
    const settings = await this.store.load();
    if (
      settings &&
      (settings.kind !== surfingStrategy.kind ||
        !surfingStrategy.validate(settings.parameters) ||
        !isTimeframe(settings.timeframe))
    )
      throw new Error('Invalid saved strategy settings');
    return { defaults, settings };
  }

  public search(query: string) {
    return this.sandbox.searchFutures(query);
  }

  public save({
    accountId,
    instrumentUid,
    emaPeriod,
    lots,
    timeframe,
  }: {
    accountId: string;
    instrumentUid: string;
    emaPeriod: number;
    lots: number;
    timeframe: Timeframe;
  }) {
    if (!surfingStrategy.validate({ emaPeriod, lots }) || !isTimeframe(timeframe))
      throw new Error('Invalid strategy settings');
    return this.sandbox.changeStrategyForAccount(accountId, instrumentUid, (instrument) =>
      this.store.save({
        instrument,
        kind: 'surfing',
        parameters: { emaPeriod, lots },
        timeframe,
      }),
    );
  }
}
