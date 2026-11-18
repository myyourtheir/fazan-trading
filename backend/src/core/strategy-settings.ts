import type { FutureContract, SandboxConnection } from './sandbox.js';

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

  search(query: string) {
    return this.sandbox.searchFutures(query);
  }

  save({ accountId, instrumentUid, emaPeriod, lots }: {
    accountId: string; instrumentUid: string; emaPeriod: number; lots: number;
  }) {
    return this.sandbox.changeStrategyForAccount(accountId, instrumentUid,
      instrument => this.store.save({ instrument, emaPeriod, lots }));
  }
}
