import { SandboxError, type FutureContract, type SandboxConnection } from './sandbox.js';

const defaults = { ticker: 'IMOEXF', emaPeriod: 55 } as const;

export type SavedStrategy = { instrument: FutureContract; emaPeriod: number; lots: number };

export interface StrategyStore {
  load(): Promise<SavedStrategy | null>;
  save(settings: SavedStrategy): Promise<void>;
}

export class StrategySettings {
  constructor(private readonly store: StrategyStore, private readonly sandbox: SandboxConnection) {}

  async get() {
    return { defaults, settings: await this.store.load() };
  }

  async search(query: string) {
    const term = query.toLowerCase();
    return (await this.sandbox.tradableFutures())
      .filter(({ ticker, name }) => ticker.toLowerCase().includes(term) || name.toLowerCase().includes(term));
  }

  save({ accountId, instrumentUid, emaPeriod, lots }: {
    accountId: string; instrumentUid: string; emaPeriod: number; lots: number;
  }) {
    return this.sandbox.changeStrategyForAccount(accountId, async contracts => {
      const instrument = contracts.find(contract => contract.uid === instrumentUid);
      if (!instrument) throw new SandboxError('FUTURE_UNAVAILABLE');
      await this.store.save({ instrument, emaPeriod, lots });
    });
  }
}
