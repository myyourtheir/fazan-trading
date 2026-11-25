import type { BacktestCandle, ResolvedBacktestContract } from './backtest.js';
import {
  BacktestError,
  backtestLimits,
  parseBacktestDate,
  type BacktestBroker,
} from './backtest-history.js';
import type { MarketBroker, MarketCandle, MarketSelection } from './market-data.js';
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

export interface HistoricalBroker extends BacktestBroker, Pick<MarketBroker, 'ema'> {
  minuteCandles(token: string, uid: string, from: Date, to: Date): Promise<MarketCandle[]>;
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
  read: (from: Date, to: Date) => Promise<MarketCandle[]>,
  interval: number,
  missing: 'BACKTEST_CANDLES_MISSING' | 'BACKTEST_MINUTES_MISSING',
) {
  const rows = new Map<number, MarketCandle>();
  for (let start = from; start < to; ) {
    const end = Math.min(start + chunk, to);
    for (const row of await read(new Date(start), new Date(end))) {
      if (row.time < start || row.time >= end) continue;
      if (!validBar(row) || row.time % interval !== 0) throw new BacktestError(missing);
      const previous = rows.get(row.time);
      if (previous && barKey(previous) !== barKey(row))
        throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
      rows.set(row.time, row);
    }
    start = end;
  }
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

const barKey = ({ open, high, low, close }: MarketCandle) => `${open}:${high}:${low}:${close}`;

export class HistoricalBacktest {
  constructor(
    private readonly broker: HistoricalBroker,
    private readonly loadToken: () => Promise<string>,
    private readonly now: () => number,
  ) {}

  public async check(parameters: FullBacktestParameters) {
    const { candles } = await this.gather(parameters);
    return { parameters: { ...parameters, timeZone: moscow }, candles, cutoff: null };
  }

  public async run(parameters: FullBacktestParameters) {
    return simulateHistory(parameters, await this.gather(parameters));
  }

  private async gather(parameters: FullBacktestParameters): Promise<HistoricalDataset> {
    const { instrumentUid: uid, timeframe, emaPeriod } = parameters;
    const first = parseBacktestDate(parameters.from);
    const last = parseBacktestDate(parameters.to);
    const days = first.until(last).days + 1;
    if (days < 1) throw new BacktestError('INVALID_REQUEST');
    if (days > backtestLimits.maxDays) throw new BacktestError('BACKTEST_PERIOD_TOO_LONG');
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
    if (
      (metadata.firstTrade && first.toString() < parseMoscowDay(metadata.firstTrade)) ||
      (metadata.lastTrade && last.toString() > parseMoscowDay(metadata.lastTrade))
    )
      throw new BacktestError('BACKTEST_CONTRACT_PERIOD');
    const contract: ResolvedBacktestContract = { currency, priceStep, priceStepAmount, lot };
    const readStrategy = (a: number, b: number) =>
      readBars(
        a,
        b,
        6 * day,
        (left, right) => this.broker.candles(token, uid, timeframe, left, right),
        interval,
        'BACKTEST_CANDLES_MISSING',
      );
    const selected = await readStrategy(from, to);
    if (!selected.length) throw new BacktestError('BACKTEST_CANDLES_MISSING');
    const minutes = await readBars(
      from,
      to,
      day,
      (a, b) => this.broker.minuteCandles(token, uid, a, b),
      minute,
      'BACKTEST_MINUTES_MISSING',
    );
    const { sessionByBucket, missingMinutes } = inferSessions(selected, minutes, interval);
    const searchedFrom = Math.max(
      from - 365 * day,
      metadata.firstTrade
        ? parseBacktestDate(parseMoscowDay(metadata.firstTrade)).toZonedDateTime(moscow)
            .epochMilliseconds
        : -Infinity,
    );
    const prior: MarketCandle[] = [];
    for (let end = from; end > searchedFrom && prior.length < required; ) {
      const start = Math.max(searchedFrom, end - 6 * day);
      prior.push(...(await readStrategy(start, end)).reverse());
      end = start;
    }
    if (prior.length < required)
      throw new BacktestError('BACKTEST_WARMUP_MISSING', {
        required,
        available: prior.length,
        searchedFrom: parseMoscowDay(new Date(searchedFrom)),
      });
    const bars = prior.slice(0, required).reverse().concat(selected);
    const ema = new Map<number, number>();
    for (let start = bars[0].time; start < to; start += 6 * day) {
      const end = Math.min(start + 6 * day, to);
      for (const row of await this.broker.ema(
        token,
        uid,
        timeframe,
        emaPeriod,
        new Date(start),
        new Date(end),
      )) {
        if (row.time < start || row.time >= end) continue;
        const previous = ema.get(row.time);
        if (previous !== undefined && previous !== row.value)
          throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
        ema.set(row.time, row.value);
      }
    }
    const rows: BacktestCandle[] = bars.map((bar) => {
      const value = ema.get(bar.time);
      if (value === undefined || !validPrice(value))
        throw new BacktestError('BACKTEST_EMA_MISSING');
      return { ...bar, ema: value };
    });
    return {
      warmup: rows.slice(0, required),
      candles: rows.slice(required),
      minutes,
      sessionByBucket,
      missingMinutes,
      contract,
      from,
    };
  }
}

function parseMoscowDay(date: Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: moscow, dateStyle: 'short' }).format(date);
}

function inferSessions(candles: MarketCandle[], minutes: MarketCandle[], interval: number) {
  const bucket = (time: number) => Math.floor(time / interval) * interval;
  const sessionByBucket = new Map<number, number>();
  let session = 0;
  let previousBucket = -Infinity;
  let previousDay: string | undefined;
  let offset = 0;
  let previousMinute: number | undefined;
  let missingMinutes = 0;
  for (const candle of candles) {
    const first = minutes[offset];
    if (!first || bucket(first.time) > candle.time)
      throw new BacktestError('BACKTEST_MINUTES_MISSING');
    if (bucket(first.time) < candle.time) throw new BacktestError('BACKTEST_CANDLES_MISSING');
    const day = parseMoscowDay(new Date(candle.time));
    if (candle.time - previousBucket !== interval || day !== previousDay) {
      session++;
      previousMinute = undefined;
    }
    sessionByBucket.set(candle.time, session);
    let high = -Infinity;
    let low = Infinity;
    let close = first.open;
    while (offset < minutes.length && bucket(minutes[offset].time) === candle.time) {
      const next = minutes[offset++];
      if (previousMinute !== undefined) missingMinutes += (next.time - previousMinute) / minute - 1;
      previousMinute = next.time;
      high = Math.max(high, next.high);
      low = Math.min(low, next.low);
      close = next.close;
    }
    if (
      candle.open !== first.open ||
      candle.high !== high ||
      candle.low !== low ||
      candle.close !== close
    )
      throw new BacktestError('BACKTEST_HISTORY_CONFLICT');
    previousBucket = candle.time;
    previousDay = day;
  }
  if (offset !== minutes.length) throw new BacktestError('BACKTEST_CANDLES_MISSING');
  return { sessionByBucket, missingMinutes };
}
