import type { ResolvedBacktestContract } from './backtest.js';
import { backtestEma } from './backtest-ema.js';
import {
  BacktestError,
  backtestWarmupStart,
  completeBacktestWarmup,
  contractHistoryBounds,
  describeCoverage,
  loadBacktestCandles,
  parseBacktestDate,
  type BacktestBroker,
  type BacktestCandleRows,
} from './backtest-history.js';
import type { MarketCandle, MarketSelection } from './market-data.js';
import type { ImprovedParameters } from './strategy-settings.js';
import { timeframeMs } from './timeframe.js';
import {
  minute,
  moscow,
  simulateHistory,
  type HistoricalDataset,
} from './historical-simulation.js';

const day = 24 * 60 * minute;

export type FullBacktestParameters = MarketSelection & {
  from: string;
  to: string;
  initialMoney: number;
  commission: number;
  slippage: number;
} & ({ kind: 'surfing'; lots: number } | ({ kind: 'improved-surfing' } & ImprovedParameters));

export interface HistoricalBroker extends BacktestBroker {
  minuteCandles(token: string, uid: string, from: Date, to: Date): Promise<BacktestCandleRows>;
}

function validPrice(value: number) {
  return Number.isFinite(value) && value > 0;
}

function validBar(bar: MarketCandle) {
  return (
    bar.complete &&
    [bar.open, bar.high, bar.low, bar.close].every(validPrice) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close)
  );
}

async function readBars(
  from: number,
  to: number,
  chunk: number,
  read: (from: Date, to: Date) => Promise<BacktestCandleRows>,
) {
  const rows = new Map<number, MarketCandle>();
  let sawUndated = false;
  for (let start = from; start < to; ) {
    const end = Math.min(start + chunk, to);
    for (const row of await loadBacktestCandles(() => read(new Date(start), new Date(end)))) {
      if (!row || !Number.isFinite(row.time)) {
        sawUndated = true;
        continue;
      }
      if (!(row.time >= start && row.time < end)) continue;
      const previous = rows.get(row.time);
      if (previous && validBar(previous) && validBar(row) && barKey(previous) !== barKey(row))
        throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
      if (!previous || !validBar(previous)) rows.set(row.time, row);
    }
    start = end;
  }
  return { bars: [...rows.values()].sort((a, b) => a.time - b.time), sawUndated };
}

const barKey = ({ open, high, low, close }: MarketCandle) => `${open}:${high}:${low}:${close}`;

function reportCandles({ candles, warmup, warmupInRange }: HistoricalDataset) {
  return warmup.slice(warmup.length - warmupInRange).concat(candles);
}

export class HistoricalBacktest {
  constructor(
    private readonly broker: HistoricalBroker,
    private readonly loadToken: () => Promise<string>,
    private readonly now: () => number,
  ) {}

  public async check(parameters: FullBacktestParameters) {
    const dataset = await this.gather(parameters);
    return {
      parameters: { ...parameters, timeZone: moscow },
      candles: reportCandles(dataset),
      cutoff: null,
      coverage: dataset.coverage,
      emaSource: 'local' as const,
    };
  }

  public async run(parameters: FullBacktestParameters) {
    const dataset = await this.gather(parameters);
    return { ...simulateHistory(parameters, dataset), candles: reportCandles(dataset) };
  }

  private async gather(parameters: FullBacktestParameters): Promise<HistoricalDataset> {
    const { instrumentUid: uid, timeframe, emaPeriod } = parameters;
    const first = parseBacktestDate(parameters.from);
    const last = parseBacktestDate(parameters.to);
    const days = first.until(last).days + 1;
    if (days < 1) throw new BacktestError('INVALID_REQUEST');
    const from = first.toZonedDateTime(moscow).epochMilliseconds;
    const to = last.add({ days: 1 }).toZonedDateTime(moscow).epochMilliseconds;
    if (to > this.now()) throw new BacktestError('BACKTEST_PERIOD_UNFINISHED');

    const interval = timeframeMs[timeframe];
    const required = Math.max(
      emaPeriod,
      parameters.kind === 'improved-surfing' ? parameters.atrPeriod + 1 : 1,
    );
    const token = await this.loadToken();
    const metadata = await this.broker.backtestFuture(token, uid);
    const { priceStep, priceStepAmount, lot, currency } = metadata;
    if (
      currency.toLowerCase() !== 'rub' ||
      priceStep === null ||
      !validPrice(priceStep) ||
      priceStepAmount === null ||
      !validPrice(priceStepAmount) ||
      !validPrice(lot) ||
      !validPrice((priceStepAmount / priceStep) * lot)
    )
      throw new BacktestError('BACKTEST_CONTRACT_PARAMS_MISSING');
    const {
      start: availableFrom,
      end: availableTo,
      contractStart,
    } = contractHistoryBounds(from, to, metadata, moscow);
    const contract: ResolvedBacktestContract = { currency, priceStep, priceStepAmount, lot };
    const readStrategy = (a: number, b: number) =>
      readBars(a, b, 6 * day, (left, right) =>
        this.broker.backtestCandles(token, uid, timeframe, left, right),
      );
    const readMinutes = (from: number, to: number) =>
      readBars(from, to, day, (a, b) => this.broker.minuteCandles(token, uid, a, b));
    const strategy = await readStrategy(availableFrom, availableTo);
    const execution = await readMinutes(availableFrom, availableTo);
    if (
      !strategy.bars.length &&
      !strategy.sawUndated &&
      !execution.bars.length &&
      !execution.sawUndated
    )
      throw new BacktestError('BACKTEST_HISTORY_EMPTY');
    const { selected, minutes, sessionByBucket, missingMinutes, excludedIntervals } =
      confirmHistory(strategy.bars, execution.bars, interval);
    if (!selected.length) throw new BacktestError('BACKTEST_NO_CONFIRMED_INTERVALS');
    const searchedFrom = backtestWarmupStart(availableFrom, contractStart);
    const prior: MarketCandle[] = [];
    for (let end = availableFrom; end > searchedFrom && prior.length < required; ) {
      const start = Math.max(searchedFrom, end - 6 * day);
      const candidates = (await readStrategy(start, end)).bars.filter(
        (bar) => validBar(bar) && bar.time % interval === 0 && bar.time + interval <= end,
      );
      if (candidates.length) {
        const { bars } = await readMinutes(
          candidates[0].time,
          candidates[candidates.length - 1].time + interval,
        );
        prior.push(...confirmHistory(candidates, bars, interval).selected.reverse());
      }
      end = start;
    }
    const { warmup, warmupInRange, readyAt } = completeBacktestWarmup(
      prior.slice(0, required).reverse(),
      selected,
      required,
      parseMoscowDay(searchedFrom),
      interval,
    );
    const seedStart = Math.max(0, warmup.length - warmupInRange - emaPeriod);
    const seedEnd = seedStart + emaPeriod;
    const ema = backtestEma(warmup.slice(seedStart, seedEnd));
    return {
      warmup: warmup.map((bar, index) =>
        index < seedEnd
          ? { ...bar, ema: index === seedEnd - 1 ? ema.initial : null }
          : ema.next(bar),
      ),
      warmupInRange,
      candles: selected.slice(warmupInRange).map(ema.next),
      minutes,
      sessionByBucket,
      missingMinutes,
      contract,
      from: availableFrom,
      coverage: {
        ...describeCoverage(parameters, selected, moscow),
        ...(excludedIntervals.length ? { excludedIntervals } : {}),
        readyAt,
      },
    };
  }
}

const parseMoscowDay = new Intl.DateTimeFormat('sv-SE', { timeZone: moscow, dateStyle: 'short' })
  .format;

function confirmHistory(candles: MarketCandle[], minuteBars: MarketCandle[], interval: number) {
  const bucket = (time: number) => Math.floor(time / interval) * interval;
  const selected: MarketCandle[] = [];
  const minutes: MarketCandle[] = [];
  const excludedIntervals: number[] = [];
  const sessionByBucket = new Map<number, number>();
  let session = 0;
  let previousBucket = -Infinity;
  let previousDay: string | undefined;
  let candleIndex = 0;
  let minuteIndex = 0;
  let previousMinute: number | undefined;
  let missingMinutes = 0;
  while (candleIndex < candles.length || minuteIndex < minuteBars.length) {
    // Only observed buckets can be unconfirmed; a pause in both feeds isn't evidence.
    const time = Math.min(
      bucket(candles[candleIndex]?.time ?? Infinity),
      bucket(minuteBars[minuteIndex]?.time ?? Infinity),
    );
    let candle: MarketCandle | undefined;
    while (candleIndex < candles.length && bucket(candles[candleIndex].time) === time) {
      const row = candles[candleIndex++];
      if (row.time === time && validBar(row)) candle = row;
    }
    const usable: MarketCandle[] = [];
    let high = -Infinity;
    let low = Infinity;
    while (minuteIndex < minuteBars.length && bucket(minuteBars[minuteIndex].time) === time) {
      const next = minuteBars[minuteIndex++];
      if (next.time % minute !== 0 || !validBar(next)) continue;
      usable.push(next);
      high = Math.max(high, next.high);
      low = Math.min(low, next.low);
    }
    if (
      !candle ||
      candle.open !== usable[0]?.open ||
      candle.high !== high ||
      candle.low !== low ||
      candle.close !== usable.at(-1)?.close
    ) {
      excludedIntervals.push(time);
      continue;
    }
    const day = parseMoscowDay(time);
    if (time - previousBucket !== interval || day !== previousDay) {
      session++;
      previousMinute = undefined;
    }
    sessionByBucket.set(time, session);
    selected.push(candle);
    for (const bar of usable) {
      if (previousMinute !== undefined) missingMinutes += (bar.time - previousMinute) / minute - 1;
      previousMinute = bar.time;
      minutes.push(bar);
    }
    previousBucket = time;
    previousDay = day;
  }
  return { selected, minutes, sessionByBucket, missingMinutes, excludedIntervals };
}
