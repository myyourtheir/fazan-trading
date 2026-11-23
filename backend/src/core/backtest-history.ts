import { Temporal } from '@js-temporal/polyfill';
import type { MarketBroker, MarketCandle } from './market-data.js';
import { timeframeMs } from './timeframe.js';
import {
  runBacktest,
  type BacktestContract,
  type BacktestDataset,
  type BacktestParameters,
  type BacktestReport,
  type BacktestCandle,
} from './backtest.js';
import { crossing } from './crossing.js';

const dayMs = 86_400_000;
const maxChunkMs = 6 * dayMs;
const maxWarmupMs = 365 * dayMs;
export const backtestLimits = { maxDays: 30, maxEmaPeriod: 1000 };

export interface BacktestBroker extends Pick<MarketBroker, 'candles'> {
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
  | 'BACKTEST_PERIOD_TOO_LONG'
  | 'BACKTEST_CONTRACT_PERIOD'
  | 'BACKTEST_CANDLES_MISSING'
  | 'BACKTEST_WARMUP_MISSING'
  | 'BACKTEST_HISTORY_CONFLICT'
  | 'BACKTEST_CONTRACT_PARAMS_MISSING';

type RawBacktestDataset = Omit<BacktestDataset, 'contract'> & { contract: BacktestContract };

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

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BacktestError('INVALID_REQUEST');
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new BacktestError('INVALID_REQUEST');
  }
}

function mergeCandle(entries: Map<number, MarketCandle>, candle: MarketCandle) {
  const previous = entries.get(candle.time);
  if (!previous?.complete) entries.set(candle.time, candle);
  else if (
    candle.complete &&
    (previous.open !== candle.open ||
      previous.high !== candle.high ||
      previous.low !== candle.low ||
      previous.close !== candle.close)
  ) {
    throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
  }
}

const byTime = (a: MarketCandle, b: MarketCandle) => a.time - b.time;

export class BacktestHistory {
  constructor(
    private readonly broker: BacktestBroker,
    private readonly loadToken: () => Promise<string>,
    private readonly now = Date.now,
  ) {}

  public async check(parameters: BacktestParameters) {
    const { parameters: selected, candles, cutoff } = await this.gather(parameters);
    return { parameters: selected, candles, cutoff };
  }

  public async run(parameters: BacktestParameters): Promise<BacktestReport> {
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
    return runBacktest({ ...dataset, contract: { currency, priceStep, priceStepAmount, lot } });
  }

  private async gather(parameters: BacktestParameters): Promise<RawBacktestDataset> {
    const { timeZone } = parameters;
    const fromDay = parseDate(parameters.from);
    const toDay = parseDate(parameters.to);
    const now = this.now();
    const localDay = (time: number) =>
      Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone).toPlainDate();
    const startOfDay = (day: Temporal.PlainDate) => day.toZonedDateTime(timeZone).epochMilliseconds;
    const days = fromDay.until(toDay).days + 1;
    if (days < 1 || Temporal.PlainDate.compare(toDay, localDay(now)) > 0) {
      throw new BacktestError('INVALID_REQUEST');
    }
    if (days > backtestLimits.maxDays) throw new BacktestError('BACKTEST_PERIOD_TOO_LONG');
    const from = startOfDay(fromDay);
    // Calendar days can be shorter or longer than 24 hours, and midnight itself can be skipped.
    const to = startOfDay(toDay.add({ days: 1 }));
    if (from >= to) throw new BacktestError('INVALID_REQUEST');

    const { instrumentUid, timeframe, emaPeriod } = parameters;
    const token = await this.loadToken();
    const contract = await this.broker.backtestFuture(token, instrumentUid);
    const firstTradeDay = contract.firstTrade && localDay(+contract.firstTrade);
    if (
      (firstTradeDay && Temporal.PlainDate.compare(fromDay, firstTradeDay) < 0) ||
      (contract.lastTrade && Temporal.PlainDate.compare(toDay, localDay(+contract.lastTrade)) > 0)
    ) {
      throw new BacktestError('BACKTEST_CONTRACT_PERIOD');
    }
    const interval = timeframeMs[timeframe];
    const end = Math.min(to, now);
    const readCandles = (start: number, stop: number) =>
      this.broker.candles(token, instrumentUid, timeframe, new Date(start), new Date(stop));
    const candles = new Map<number, MarketCandle>();
    for (let start = from; start < end; ) {
      const stop = Math.min(start + maxChunkMs, end);
      for (const bar of await readCandles(start, stop)) {
        if (bar.time >= start && bar.time <= stop && bar.time < to && bar.time + interval <= now) {
          mergeCandle(candles, bar);
        }
      }
      if (stop === end) break;
      start = stop - interval;
    }

    const selected = [...candles.values()].sort(byTime);
    if (
      selected.length === 0 ||
      selected.some(
        (bar) => !bar.complete || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
      )
    ) {
      throw new BacktestError('BACKTEST_CANDLES_MISSING');
    }

    const earliest = Math.max(
      from - maxWarmupMs,
      firstTradeDay ? startOfDay(firstTradeDay) : -Infinity,
    );
    const before = new Map<number, MarketCandle>();
    for (let stop = from; stop > earliest && before.size < emaPeriod; ) {
      const start = Math.max(stop - maxChunkMs, earliest);
      for (const bar of await readCandles(start, stop)) {
        if (
          bar.time >= start &&
          bar.time <= stop &&
          bar.time + interval <= from &&
          bar.complete &&
          Number.isFinite(bar.close)
        ) {
          mergeCandle(before, bar);
        }
      }
      if (start === earliest) break;
      stop = start + interval;
    }
    if (before.size < emaPeriod) {
      throw new BacktestError('BACKTEST_WARMUP_MISSING', {
        required: emaPeriod,
        available: before.size,
        searchedFrom: localDay(earliest).toString(),
      });
    }

    // Use exactly the nearest N closes, regardless of where the broker's request pages begin.
    const warmup = [...before.values()].sort(byTime).slice(-emaPeriod);
    const lastWarmupClose = warmup[warmup.length - 1].close;
    // Averaging offsets preserves exact equality for a flat warmup, even with decimal prices.
    let ema =
      lastWarmupClose +
      warmup.reduce((sum, bar) => sum + (bar.close - lastWarmupClose), 0) / emaPeriod;
    const initialSide = crossing(null, lastWarmupClose, ema).side;
    const alpha = 2 / (emaPeriod + 1);
    const rows: BacktestCandle[] = selected.map((bar) => {
      ema = emaPeriod === 1 ? bar.close : ema + (bar.close - ema) * alpha;
      return { ...bar, ema };
    });

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
      initialSide,
      cutoff: end < to ? end : null,
    };
  }
}
