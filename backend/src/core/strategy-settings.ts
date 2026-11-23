import type { FutureContract, SandboxConnection } from './sandbox.js';
import { defaultTimeframe, type Timeframe, isTimeframe } from './timeframe.js';
import { surfingStrategy } from './surfing-strategy.js';

const defaults = { ticker: 'IMOEXF', emaPeriod: 55, timeframe: defaultTimeframe } as const;
export const improvedDefaults = {
  ticker: 'IMOEXF',
  timeframe: defaultTimeframe,
  emaPeriod: 55,
  atrPeriod: 20,
  stopAtrMultiplier: 2,
  addStepAtr: 1,
  maxAddOns: 3,
  tradeWeekends: false,
} as const;
export type StrategyKind = 'surfing' | 'improved-surfing';
export type ImprovedParameters = {
  emaPeriod: number;
  atrPeriod: number;
  stopAtrMultiplier: number;
  addStepAtr: number;
  maxAddOns: number;
  tradeWeekends: boolean;
};
export type SavedStrategy = {
  instrument: FutureContract;
  timeframe: Timeframe;
  kind: 'surfing';
  parameters: { emaPeriod: number; lots: number };
};
export type SavedImprovedStrategy = {
  instrument: FutureContract;
  timeframe: Timeframe;
  kind: 'improved-surfing';
  parameters: ImprovedParameters;
};
export type AnySavedStrategy = SavedStrategy | SavedImprovedStrategy;
export function isStrategyKind(value: unknown): value is StrategyKind {
  return value === 'surfing' || value === 'improved-surfing';
}
export function validImproved(value: unknown): value is ImprovedParameters {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const integer = (v: unknown, min: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 2147483647;
  const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return (
    Object.keys(p).length === 6 &&
    integer(p.emaPeriod, 1) &&
    integer(p.atrPeriod, 1) &&
    positive(p.stopAtrMultiplier) &&
    positive(p.addStepAtr) &&
    integer(p.maxAddOns, 0) &&
    typeof p.tradeWeekends === 'boolean'
  );
}
export interface StrategyStore {
  load(): Promise<SavedStrategy | null>;
  save(settings: SavedStrategy): Promise<void>;
  claimLegacy(): Promise<void>;
  loadImproved(): Promise<SavedImprovedStrategy | null>;
  saveImproved(settings: SavedImprovedStrategy): Promise<void>;
  selected(): Promise<StrategyKind>;
  select(kind: StrategyKind): Promise<void>;
  legacyClaimAvailable(): Promise<boolean>;
}
export class StrategySettingsError extends Error {
  readonly status = 409;
  constructor(readonly code: string) {
    super(code);
  }
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
  public async profiles() {
    const [surfing, improved, selected, legacyClaimAvailable] = await Promise.all([
      this.get(),
      this.store.loadImproved(),
      this.store.selected(),
      this.store.legacyClaimAvailable(),
    ]);
    if (improved && (!validImproved(improved.parameters) || !isTimeframe(improved.timeframe)))
      throw new Error('Invalid saved strategy settings');
    return {
      selected,
      profiles: { surfing, 'improved-surfing': { defaults: improvedDefaults, settings: improved } },
      legacyClaimAvailable,
    };
  }
  public async selectedProfile(): Promise<AnySavedStrategy | null> {
    return (await this.store.selected()) === 'surfing'
      ? (await this.get()).settings
      : this.store.loadImproved();
  }
  public async selectedKind() {
    return this.store.selected();
  }
  public search(query: string) {
    return this.sandbox.searchFutures(query);
  }
  public claimLegacy() {
    return this.store.claimLegacy();
  }
  public select(accountId: string, kind: StrategyKind) {
    return this.sandbox.changeStrategySelection(accountId, () => this.store.select(kind));
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
      this.store.save({ instrument, kind: 'surfing', parameters: { emaPeriod, lots }, timeframe }),
    );
  }
  public saveImproved(
    accountId: string,
    instrumentUid: string,
    timeframe: Timeframe,
    parameters: ImprovedParameters,
  ) {
    if (!validImproved(parameters) || !isTimeframe(timeframe))
      throw new Error('Invalid strategy settings');
    return this.sandbox.changeStrategyForAccount(accountId, instrumentUid, (instrument) =>
      this.store.saveImproved({ instrument, kind: 'improved-surfing', parameters, timeframe }),
    );
  }
}
