import type { MarketBroker, MarketCandle } from './market-data.js';
import { timeframeMs } from './timeframe.js';
import { runBacktest, type BacktestContract, type BacktestDataset, type BacktestParameters, type BacktestReport, type BacktestCandle } from './backtest.js';
import type { Side } from './crossing.js';

const dayMs = 86_400_000;
const maxChunkMs = 6 * dayMs;
const baselineMs = 7 * dayMs;
export const backtestLimits = { maxDays: 30, maxEmaPeriod: 1000 };

const moscowDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' });
const moscowOffset = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', timeZoneName: 'longOffset' });

export interface BacktestBroker extends Pick<MarketBroker, 'candles' | 'ema'> {
  backtestFuture(token: string, uid: string): Promise<{
    firstTrade: Date | undefined; lastTrade: Date | undefined; currency: string;
    priceStep: number | null; priceStepAmount: number | null; lot: number;
  }>;
}

type BacktestErrorCode = 'INVALID_REQUEST' | 'BACKTEST_PERIOD_TOO_LONG' | 'BACKTEST_CONTRACT_PERIOD'
  | 'BACKTEST_CANDLES_MISSING' | 'BACKTEST_EMA_MISSING' | 'BACKTEST_BASELINE_MISSING' | 'BACKTEST_HISTORY_CONFLICT'
  | 'BACKTEST_CONTRACT_PARAMS_MISSING';

type RawBacktestDataset = Omit<BacktestDataset, 'contract'> & { contract: BacktestContract };

export class BacktestError extends Error {
  constructor(readonly code: BacktestErrorCode) {
    super(code);
  }
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BacktestError('INVALID_REQUEST');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BacktestError('INVALID_REQUEST');
  }
  return +parsed;
}

function moscowMidnight(calendarDay: number) {
  const date = new Date(calendarDay).toISOString().slice(0, 10);
  const offset = moscowOffset.formatToParts(calendarDay).find(part => part.type === 'timeZoneName')?.value;
  // Since 2014 Moscow is UTC+3; use the IANA offset rather than applying that to earlier history.
  return Date.parse(`${date}T00:00:00${offset?.slice(3) || 'Z'}`);
}

function merge<T>(entries: Map<number, T>, time: number, value: T, equal: (a: T, b: T) => boolean) {
  const previous = entries.get(time);
  if (previous !== undefined && !equal(previous, value)) throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
  entries.set(time, value);
}

// GetTechAnalysis recomputes EMA from each request's own start, so a value read on both sides of a
// chunk seam can drift by a small relative amount without meaning the broker returned conflicting data.
const emaSeamTolerance = 1e-9;
function closeEnough(a: number, b: number) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= scale * emaSeamTolerance;
}

function mergeCandle(entries: Map<number, MarketCandle>, candle: MarketCandle) {
  const previous = entries.get(candle.time);
  if (previous?.complete && !candle.complete) return;
  if (!previous?.complete) entries.set(candle.time, candle);
  else merge(entries, candle.time, candle, (a, b) => (
    a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close
  ));
}

export class BacktestHistory {
  constructor(
    private readonly broker: BacktestBroker,
    private readonly loadToken: () => Promise<string>,
    private readonly now = Date.now,
  ) {}

  async check(parameters: BacktestParameters) {
    const { parameters: selected, candles, cutoff } = await this.gather(parameters);
    return { parameters: selected, candles, cutoff };
  }

  async run(parameters: BacktestParameters): Promise<BacktestReport> {
    const dataset = await this.gather(parameters);
    const { priceStep, priceStepAmount, lot, currency } = dataset.contract;
    if (!currency || priceStep === null || !Number.isFinite(priceStep) || priceStep <= 0
      || priceStepAmount === null || !Number.isFinite(priceStepAmount) || priceStepAmount <= 0
      || !Number.isFinite(lot) || lot <= 0) {
      throw new BacktestError('BACKTEST_CONTRACT_PARAMS_MISSING');
    }
    return runBacktest({ ...dataset, contract: { currency, priceStep, priceStepAmount, lot } });
  }

  private async gather(parameters: BacktestParameters): Promise<RawBacktestDataset> {
    const fromDay = parseDate(parameters.from);
    const toDay = parseDate(parameters.to);
    const from = moscowMidnight(fromDay);
    const to = moscowMidnight(toDay + dayMs);
    const now = this.now();
    if (!Number.isFinite(from) || !Number.isFinite(to) || fromDay > toDay || parameters.to > moscowDate.format(now)) {
      throw new BacktestError('INVALID_REQUEST');
    }
    if ((toDay - fromDay) / dayMs + 1 > backtestLimits.maxDays) throw new BacktestError('BACKTEST_PERIOD_TOO_LONG');

    const { instrumentUid, timeframe, emaPeriod } = parameters;
    const token = await this.loadToken();
    const contract = await this.broker.backtestFuture(token, instrumentUid);
    if ((contract.firstTrade && parameters.from < moscowDate.format(contract.firstTrade))
      || (contract.lastTrade && parameters.to > moscowDate.format(contract.lastTrade))) {
      throw new BacktestError('BACKTEST_CONTRACT_PERIOD');
    }
    const interval = timeframeMs[timeframe];
    const end = Math.min(to, now);
    const candles = new Map<number, MarketCandle>();
    const ema = new Map<number, number>();
    for (let start = from - baselineMs; start < end;) {
      const stop = Math.min(start + maxChunkMs, end);
      const [bars, points] = await Promise.all([
        this.broker.candles(token, instrumentUid, timeframe, new Date(start), new Date(stop)),
        this.broker.ema(token, instrumentUid, timeframe, emaPeriod, new Date(start), new Date(stop)),
      ]);
      for (const bar of bars) {
        if (bar.time >= start && bar.time <= stop && bar.time < to) mergeCandle(candles, bar);
      }
      for (const point of points) {
        // A forming candle cannot provide a confirmed value or a conflict with another request.
        if (point.time >= start && point.time <= stop && point.time < to && point.time + interval <= now) {
          merge(ema, point.time, point.value, closeEnough);
        }
      }
      if (stop === end) break;
      start = stop - interval;
    }

    const elapsed = [...candles.values()]
      .filter(bar => bar.time + interval <= now)
      .sort((a, b) => a.time - b.time);
    const selected = elapsed.filter(bar => bar.time >= from);
    if (selected.length === 0
      || selected.some(bar => !bar.complete || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      || [...ema.keys()].some(time => time >= from && !candles.has(time))) {
      throw new BacktestError('BACKTEST_CANDLES_MISSING');
    }
    const rows: BacktestCandle[] = selected.map(bar => {
      const value = ema.get(bar.time);
      if (value === undefined || !Number.isFinite(value)) throw new BacktestError('BACKTEST_EMA_MISSING');
      return { ...bar, ema: value };
    });

    // Find the last known strict side before the period in order; do not use an old baseline across a
    // hole in just one feed. Equality preserves the previous strict side, so the nearest strict candle
    // below `from` fully determines the initial side.
    const before = [...new Set([...ema.keys(), ...elapsed.map(bar => bar.time)])]
      .filter(time => time + interval <= from).sort((a, b) => b - a);
    let initialSide: Side | null = null;
    for (const time of before) {
      const bar = candles.get(time);
      const value = ema.get(time);
      if (!bar?.complete || !Number.isFinite(bar.close) || value === undefined || !Number.isFinite(value)) break;
      if (bar.close !== value) { initialSide = bar.close > value ? 1 : -1; break; }
    }
    if (initialSide === null) throw new BacktestError('BACKTEST_BASELINE_MISSING');

    const contractData: BacktestContract = {
      currency: contract.currency, priceStep: contract.priceStep, priceStepAmount: contract.priceStepAmount, lot: contract.lot,
    };
    return { parameters, candles: rows, contract: contractData, initialSide, cutoff: end < to ? end : null };
  }
}
