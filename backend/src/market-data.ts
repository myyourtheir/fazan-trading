import { setTimeout as delay } from 'node:timers/promises';

const hourMs = 60 * 60_000;
const historyMs = 7 * 24 * hourMs;

export type HourlyCandle = {
  time: number; // UTC opening time in milliseconds
  open: number; high: number; low: number; close: number; complete: boolean;
};
type ChartCandle = HourlyCandle & { confirmedEma: number | null; previewEma: number | null };
type MarketSelection = { instrumentUid: string; emaPeriod: number };
type MarketConfig = MarketSelection & { token: string };
export type MarketHistory = MarketSelection & { candles: ChartCandle[] };
type StreamState = 'unconfigured' | 'connecting' | 'live' | 'disconnected';
export type MarketUpdate = {
  stream: StreamState;
  history?: MarketHistory;
  tick?: MarketSelection & { candle: ChartCandle };
};
type MarketListener = (update: MarketUpdate) => void;
type BrokerEvent = { kind: 'subscribed' } | { kind: 'candle'; candle: HourlyCandle };

export interface MarketBroker {
  candles(token: string, uid: string, from: Date, to: Date, signal?: AbortSignal): Promise<HourlyCandle[]>;
  ema(token: string, uid: string, period: number, from: Date, to: Date, signal?: AbortSignal):
    Promise<{ time: number; value: number }[]>;
  stream(token: string, uid: string, signal: AbortSignal): AsyncIterable<BrokerEvent>;
}

class MarketSeries {
  private readonly candles = new Map<number, HourlyCandle>();
  private readonly ema = new Map<number, number>();
  private readonly liveTimes = new Set<number>();

  constructor(private readonly selection: MarketSelection) {}

  resetStream() { this.liveTimes.clear(); }

  tick(candle: HourlyCandle) {
    if (this.candles.get(candle.time)?.complete) return;
    this.candles.set(candle.time, { ...candle, complete: false });
    this.liveTimes.add(candle.time);
  }

  merge(candles: HourlyCandle[], ema: { time: number; value: number }[]) {
    for (const candle of candles) {
      if (candle.complete || (!this.candles.get(candle.time)?.complete && !this.liveTimes.has(candle.time))) {
        this.candles.set(candle.time, candle);
      }
    }
    for (const { time, value } of ema) {
      if (this.candles.get(time)?.complete) this.ema.set(time, value);
    }
  }

  history(now: number): MarketHistory {
    for (const time of this.candles.keys()) {
      if (time >= now - historyMs) continue;
      this.candles.delete(time);
      this.ema.delete(time);
      this.liveTimes.delete(time);
    }
    let lastConfirmed: number | null = null;
    const sorted = [...this.candles.values()].sort((a, b) => a.time - b.time);
    const candles = sorted.map((candle, index): ChartCandle => {
      const confirmedEma = this.ema.get(candle.time) ?? null;
      const previewEma = index === sorted.length - 1 && !candle.complete && now < candle.time + hourMs
        && lastConfirmed !== null
        ? lastConfirmed + (candle.close - lastConfirmed) * 2 / (this.selection.emaPeriod + 1)
        : null;
      if (confirmedEma !== null) lastConfirmed = confirmedEma;
      return { ...candle, confirmedEma, previewEma };
    });
    const { instrumentUid, emaPeriod } = this.selection;
    return { instrumentUid, emaPeriod, candles };
  }
}

class MarketFeed {
  readonly listeners = new Set<MarketListener>();
  readonly controller = new AbortController();
  history?: MarketHistory;
  state: StreamState = 'connecting';

  constructor(readonly config: MarketConfig) {}

  matches({ instrumentUid, emaPeriod, token }: MarketConfig) {
    return this.config.instrumentUid === instrumentUid && this.config.emaPeriod === emaPeriod && this.config.token === token;
  }

  publish(update: MarketUpdate) {
    if (update.stream === this.state && !update.history && !update.tick) return;
    this.state = update.stream;
    if (update.history) this.history = update.history;
    for (const listener of this.listeners) listener(update);
  }
}

export class MarketData {
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private feed?: MarketFeed;

  constructor(
    private readonly broker: MarketBroker,
    private readonly loadConfig: () => Promise<MarketConfig | null>,
    options: { now?: () => number; refreshMs?: number; retryMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? 30_000;
    this.retryMs = options.retryMs ?? 5_000;
  }

  async history() {
    const config = await this.loadConfig();
    if (!config) return null;
    const series = new MarketSeries(config);
    await this.refresh(series, config);
    return series.history(this.now());
  }

  async subscribe(listener: MarketListener) {
    const config = await this.loadConfig();
    if (!config) {
      listener({ stream: 'unconfigured' });
      return () => {};
    }
    let feed = this.feed;
    if (!feed?.matches(config)) {
      feed?.controller.abort();
      feed = this.feed = new MarketFeed(config);
      void this.run(feed);
    }
    feed.listeners.add(listener);
    listener({ stream: feed.state, history: feed.history });
    return () => {
      feed.listeners.delete(listener);
      if (feed.listeners.size === 0) {
        feed.controller.abort();
        if (this.feed === feed) this.feed = undefined;
      }
    };
  }

  private async refresh(series: MarketSeries, { token, instrumentUid, emaPeriod }: MarketConfig, signal?: AbortSignal) {
    const now = this.now();
    const from = new Date(now - historyMs);
    const to = new Date(now);
    const candles = await this.broker.candles(token, instrumentUid, from, to, signal);
    if (signal?.aborted) return;
    // Read the indicator after observing completion, not in parallel with that check.
    const ema = candles.some(candle => candle.complete)
      ? await this.broker.ema(token, instrumentUid, emaPeriod, from, to, signal).catch(() => [])
      : [];
    if (!signal?.aborted) series.merge(candles, ema);
  }

  private async run(feed: MarketFeed) {
    const { config, controller } = feed;
    const series = new MarketSeries(config);
    const publishHistory = () => {
      const history = series.history(this.now());
      if (JSON.stringify(history) !== JSON.stringify(feed.history)) feed.publish({ stream: feed.state, history });
    };
    const poll = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        let refreshed = false;
        try {
          await this.refresh(series, config, signal);
          refreshed = true;
        } catch { /* Keep the last successful snapshot and retry. */ }
        if (!signal.aborted && (refreshed || feed.history)) publishHistory();
        await delay(this.refreshMs, undefined, { signal }).catch(() => {});
      }
    };
    while (!controller.signal.aborted) {
      series.resetStream();
      const attempt = new AbortController();
      const signal = AbortSignal.any([attempt.signal, controller.signal]);
      let polling: Promise<void> | undefined;
      try {
        for await (const event of this.broker.stream(config.token, config.instrumentUid, signal)) {
          if (signal.aborted) break;
          if (event.kind === 'subscribed') {
            feed.publish({ stream: 'live' });
            polling ??= poll(signal);
          } else {
            series.tick(event.candle);
            if (feed.history) publishHistory();
            else {
              const { instrumentUid, emaPeriod, candles } = series.history(this.now());
              const candle = candles.find(candle => candle.time === event.candle.time);
              if (candle) feed.publish({ stream: feed.state, tick: { instrumentUid, emaPeriod, candle } });
            }
          }
        }
      } catch { /* The broker stream ended; reconnect below. */ }
      finally {
        attempt.abort();
        await polling;
      }
      if (controller.signal.aborted) break;
      const history = feed.history && { ...feed.history, candles: feed.history.candles.map(candle =>
        candle.previewEma === null ? candle : { ...candle, previewEma: null }) };
      feed.publish({ stream: 'disconnected', history });
      await delay(this.retryMs, undefined, { signal: controller.signal }).catch(() => {});
      if (!controller.signal.aborted) feed.publish({ stream: 'connecting' });
    }
  }
}
