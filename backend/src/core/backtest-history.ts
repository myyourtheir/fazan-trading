import { Temporal } from '@js-temporal/polyfill';
import type { MarketCandle } from './market-data.js';
import type { Side } from './crossing.js';
import { timeframeMs, type Timeframe } from './timeframe.js';
import {
  runBacktest,
  type BacktestContract,
  type BacktestDataset,
  type BacktestBaseParameters,
  type BacktestParameters,
  type BacktestChartCandle,
  type BacktestReport,
} from './backtest.js';

const dayMs = 86_400_000;
const maxChunkMs = 6 * dayMs;
const maxWarmupMs = 365 * dayMs;
export const backtestLimits = { maxEmaPeriod: 1000 };

// Undated broker rows are observable but cannot be assigned to an interval.
export type BacktestCandleRows = (MarketCandle | null)[];

export interface BacktestBroker {
  backtestCandles(
    token: string,
    uid: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<BacktestCandleRows>;
  backtestFuture(
    token: string,
    uid: string,
  ): Promise<{
    firstTrade: Date | undefined;
    lastTrade: Date | undefined;
    currency: string;
    priceStep: number | null;
    priceStepAmount: number | null;
    lot: number;
  }>;
}

type BacktestErrorCode =
  | 'INVALID_REQUEST'
  | 'BACKTEST_HISTORY_EMPTY'
  | 'BACKTEST_CANDLES_MISSING'
  | 'BACKTEST_NO_CONFIRMED_INTERVALS'
  | 'BACKTEST_CANDLES_LOAD_FAILED'
  | 'BACKTEST_PERIOD_UNFINISHED'
  | 'BACKTEST_EXECUTION_PRICE_INVALID'
  | 'BACKTEST_WARMUP_MISSING'
  | 'BACKTEST_HISTORY_CONFLICT'
  | 'BACKTEST_CONTRACT_PARAMS_MISSING';

export type BacktestAdapter<P extends BacktestBaseParameters, C extends MarketCandle, S> = {
  emaSource?: 'local';
  warmupCount(parameters: P): number;
  prepare(
    parameters: P,
    selected: MarketCandle[],
    warmup: MarketCandle[],
    warmupInRange: number,
  ): { candles: C[]; initialState: S };
  decide(
    state: S,
    candle: C,
    parameters: P,
  ): { state: S; signal: { targetPosition: number } | null } | undefined;
};
type RawBacktestDataset<P, C extends MarketCandle, S> = Omit<
  BacktestDataset<P, C, S>,
  'contract'
> & { contract: BacktestContract; coverage: BacktestCoverage };

export type BacktestCoverage = {
  requested: { from: string; to: string };
  actual: { from: number; to: number };
  uncoveredStart: boolean;
  uncoveredEnd: boolean;
  excludedIntervals?: number[];
  readyAt?: number;
};

export class BacktestError extends Error {
  constructor(
    readonly code: BacktestErrorCode,
    readonly details?: {
      required: number;
      available: number;
      searchedFrom: string;
    },
  ) {
    super(code);
  }
}

export function parseBacktestDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BacktestError('INVALID_REQUEST');
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new BacktestError('INVALID_REQUEST');
  }
}

export function backtestCalendar(timeZone: string) {
  const localDay = (time: number) =>
    Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone).toPlainDate();
  const startOfDay = (day: Temporal.PlainDate) => day.toZonedDateTime(timeZone).epochMilliseconds;
  return { localDay, startOfDay };
}

export function contractHistoryBounds(
  from: number,
  to: number,
  { firstTrade, lastTrade }: Awaited<ReturnType<BacktestBroker['backtestFuture']>>,
  timeZone: string,
) {
  const { localDay, startOfDay } = backtestCalendar(timeZone);
  const contractStart = firstTrade ? startOfDay(localDay(+firstTrade)) : -Infinity;
  const last = lastTrade ? startOfDay(localDay(+lastTrade).add({ days: 1 })) : Infinity;
  const start = Math.max(from, contractStart);
  const end = Math.min(to, last);
  if (start >= end) throw new BacktestError('BACKTEST_HISTORY_EMPTY');
  return { start, end, contractStart };
}

export const backtestWarmupStart = (availableFrom: number, contractStart: number) =>
  Math.max(availableFrom - maxWarmupMs, contractStart);

export function describeCoverage(
  { from, to }: { from: string; to: string },
  candles: readonly MarketCandle[],
  timeZone: string,
): BacktestCoverage {
  const { localDay } = backtestCalendar(timeZone);
  const actual = { from: candles[0].time, to: candles[candles.length - 1].time };
  return {
    requested: { from, to },
    actual,
    uncoveredStart: localDay(actual.from).toString() !== from,
    uncoveredEnd: localDay(actual.to).toString() !== to,
  };
}

export async function loadBacktestCandles(read: () => Promise<BacktestCandleRows>) {
  try {
    return await read();
  } catch {
    throw new BacktestError('BACKTEST_CANDLES_LOAD_FAILED');
  }
}

export function completeBacktestWarmup(
  prior: MarketCandle[],
  selected: MarketCandle[],
  required: number,
  searchedFrom: string,
  interval: number,
) {
  const warmupInRange = Math.max(0, required - prior.length);
  if (warmupInRange > selected.length)
    throw new BacktestError('BACKTEST_WARMUP_MISSING', {
      required,
      available: prior.length + selected.length,
      searchedFrom,
    });
  const warmup = required ? prior.slice(-required).concat(selected.slice(0, warmupInRange)) : [];
  // Indicators use completed candles, so the readiness boundary is the closing time.
  const readyAt = warmupInRange ? selected[warmupInRange - 1].time + interval : undefined;
  return { warmup, warmupInRange, readyAt };
}

function mergeCandle(entries: Map<number, MarketCandle>, candle: MarketCandle) {
  const previous = entries.get(candle.time);
  if (!previous || !usableCandle(previous)) entries.set(candle.time, candle);
  else if (
    usableCandle(candle) &&
    (previous.open !== candle.open ||
      previous.high !== candle.high ||
      previous.low !== candle.low ||
      previous.close !== candle.close)
  ) {
    throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
  }
}

const byTime = (a: MarketCandle, b: MarketCandle) => a.time - b.time;
const usableCandle = (bar: MarketCandle) =>
  bar.complete && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);

export class BacktestHistory<
  P extends BacktestBaseParameters = BacktestParameters,
  C extends MarketCandle = BacktestChartCandle,
  S = Side | null,
> {
  constructor(
    private readonly broker: BacktestBroker,
    private readonly loadToken: () => Promise<string>,
    private readonly now: () => number,
    private readonly adapter: BacktestAdapter<P, C, S>,
  ) {}

  public async check(parameters: P) {
    const { parameters: selected, candles, cutoff, coverage } = await this.gather(parameters);
    return { parameters: selected, candles, cutoff, coverage, emaSource: this.adapter.emaSource };
  }

  public async run(parameters: P): Promise<
    BacktestReport<P, C> & {
      coverage: BacktestCoverage;
      emaSource?: 'local';
    }
  > {
    const dataset = await this.gather(parameters);
    const { priceStep, priceStepAmount, lot, currency } = dataset.contract;
    if (
      !currency ||
      priceStep === null ||
      !Number.isFinite(priceStep) ||
      priceStep <= 0 ||
      priceStepAmount === null ||
      !Number.isFinite(priceStepAmount) ||
      priceStepAmount <= 0 ||
      !Number.isFinite(lot) ||
      lot <= 0
    ) {
      throw new BacktestError('BACKTEST_CONTRACT_PARAMS_MISSING');
    }
    return {
      ...runBacktest(
        { ...dataset, contract: { currency, priceStep, priceStepAmount, lot } },
        this.adapter.decide,
      ),
      emaSource: this.adapter.emaSource,
      coverage: dataset.coverage,
    };
  }

  private async gather(parameters: P): Promise<RawBacktestDataset<P, C, S>> {
    const { timeZone } = parameters;
    const fromDay = parseBacktestDate(parameters.from);
    const toDay = parseBacktestDate(parameters.to);
    const now = this.now();
    const { localDay, startOfDay } = backtestCalendar(timeZone);
    const days = fromDay.until(toDay).days + 1;
    if (days < 1 || Temporal.PlainDate.compare(toDay, localDay(now)) > 0) {
      throw new BacktestError('INVALID_REQUEST');
    }
    const from = startOfDay(fromDay);
    // Calendar days can be shorter or longer than 24 hours, and midnight itself can be skipped.
    const to = startOfDay(toDay.add({ days: 1 }));
    if (from >= to) throw new BacktestError('INVALID_REQUEST');

    const { instrumentUid, timeframe } = parameters;
    const warmupCount = this.adapter.warmupCount(parameters);
    const token = await this.loadToken();
    const contract = await this.broker.backtestFuture(token, instrumentUid);
    const interval = timeframeMs[timeframe];
    const {
      start: availableFrom,
      end,
      contractStart,
    } = contractHistoryBounds(from, to, contract, timeZone);
    const cutoff = Math.min(to, now);
    const availableTo = Math.min(end, cutoff);
    const readCandles = (start: number, stop: number) =>
      loadBacktestCandles(() =>
        this.broker.backtestCandles(
          token,
          instrumentUid,
          timeframe,
          new Date(start),
          new Date(stop),
        ),
      );
    const candles = new Map<number, MarketCandle>();
    let sawUndated = false;
    for (let start = availableFrom; start < availableTo; ) {
      const stop = Math.min(start + maxChunkMs, availableTo);
      for (const bar of await readCandles(start, stop)) {
        if (!bar || !Number.isFinite(bar.time)) sawUndated = true;
        else if (bar.time >= start && bar.time <= stop && bar.time < availableTo) {
          mergeCandle(candles, bar);
        }
      }
      if (stop === availableTo) break;
      start = stop - interval;
    }

    if (!candles.size && !sawUndated) throw new BacktestError('BACKTEST_HISTORY_EMPTY');
    const selected = [...candles.values()]
      .filter((bar) => usableCandle(bar) && bar.time + interval <= now)
      .sort(byTime);
    if (!selected.length) throw new BacktestError('BACKTEST_CANDLES_MISSING');

    const earliest = backtestWarmupStart(availableFrom, contractStart);
    const before = new Map<number, MarketCandle>();
    for (let stop = availableFrom; stop > earliest && before.size < warmupCount; ) {
      const start = Math.max(stop - maxChunkMs, earliest);
      for (const bar of await readCandles(start, stop)) {
        if (
          bar &&
          bar.time >= start &&
          bar.time <= stop &&
          bar.time + interval <= availableFrom &&
          usableCandle(bar)
        ) {
          mergeCandle(before, bar);
        }
      }
      if (start === earliest) break;
      stop = start + interval;
    }
    const { warmup, warmupInRange, readyAt } = completeBacktestWarmup(
      [...before.values()].sort(byTime),
      selected,
      warmupCount,
      localDay(earliest).toString(),
      interval,
    );
    const { candles: rows, initialState } = this.adapter.prepare(
      parameters,
      selected,
      warmup,
      warmupInRange,
    );

    const contractData: BacktestContract = {
      currency: contract.currency,
      priceStep: contract.priceStep,
      priceStepAmount: contract.priceStepAmount,
      lot: contract.lot,
    };
    return {
      parameters,
      candles: rows,
      contract: contractData,
      initialState,
      warmupInRange,
      cutoff: cutoff < to ? cutoff : null,
      coverage: { ...describeCoverage(parameters, selected, timeZone), readyAt },
    };
  }
}
