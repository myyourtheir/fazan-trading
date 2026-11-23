import { setTimeout as delay } from 'node:timers/promises';
import { timeframeMs, type Timeframe } from './timeframe.js';

const historyMs = 7 * 24 * timeframeMs['1h'];

export type MarketCandle = {
  time: number; // UTC opening time in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
};
type ChartCandle = MarketCandle & { confirmedEma: number | null; previewEma: number | null };
export type MarketSelection = { instrumentUid: string; emaPeriod: number; timeframe: Timeframe };
type MarketConfig = MarketSelection & { token: string };
export type MarketHistory = MarketSelection & { candles: ChartCandle[] };
type StreamState = 'unconfigured' | 'connecting' | 'live' | 'disconnected';
export type MarketUpdate = {
  stream: StreamState;
  history?: MarketHistory;
  tick?: MarketSelection & { candle: ChartCandle };
  recoveredAt?: number; // Trading cutoff of the authoritative snapshot that ended a broker reconnect.
};
type MarketListener = (update: MarketUpdate) => void;
type BrokerEvent = { kind: 'subscribed' } | { kind: 'candle'; candle: MarketCandle };
type BrokerSnapshot = { candles: MarketCandle[]; ema: { time: number; value: number }[] | null };

export interface MarketBroker {
  candles(
    token: string,
    uid: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ): Promise<MarketCandle[]>;
  ema(
    token: string,
    uid: string,
    timeframe: Timeframe,
    period: number,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ): Promise<{ time: number; value: number }[]>;
  stream(
    token: string,
    uid: string,
    timeframe: Timeframe,
    signal: AbortSignal,
  ): AsyncIterable<BrokerEvent>;
}

export function sameMarketSelection(a: MarketSelection, b: MarketSelection) {
  return (
    a.instrumentUid === b.instrumentUid &&
    a.emaPeriod === b.emaPeriod &&
    a.timeframe === b.timeframe
  );
}

function hasRecoveryBaseline({ candles }: BrokerSnapshot, cutoff: number, intervalMs: number) {
  const lastClosed = Math.floor(cutoff / intervalMs) * intervalMs - intervalMs;
  return candles.some(
    (candle) => candle.time === lastClosed && candle.complete && Number.isFinite(candle.close),
  );
}

class MarketSeries {
  private readonly candles = new Map<number, MarketCandle>();
  private readonly ema = new Map<number, number>();
  private readonly emaVersions = new Map<number, number>();
  private emaRequest = 0;
  private readonly liveTimes = new Set<number>();

  constructor(private readonly selection: MarketSelection) {}

  public resetStream() {
    this.liveTimes.clear();
  }

  public tick(candle: MarketCandle) {
    if (this.candles.get(candle.time)?.complete) return;
    this.candles.set(candle.time, { ...candle, complete: false });
    this.liveTimes.add(candle.time);
  }

  public merge(candles: MarketCandle[]) {
    for (const candle of candles) {
      if (
        candle.complete ||
        (!this.candles.get(candle.time)?.complete && !this.liveTimes.has(candle.time))
      ) {
        this.candles.set(candle.time, candle);
      }
    }
  }

  public beginEma(candles: MarketCandle[]) {
    const completed = new Set(
      candles.filter((candle) => candle.complete).map((candle) => candle.time),
    );
    const version = ++this.emaRequest;
    return (ema: { time: number; value: number }[]) => {
      for (const { time, value } of ema) {
        if (
          completed.has(time) &&
          this.candles.get(time)?.complete &&
          version > (this.emaVersions.get(time) ?? 0)
        ) {
          this.ema.set(time, value);
          this.emaVersions.set(time, version);
        }
      }
    };
  }

  public history(now: number): MarketHistory {
    for (const time of this.candles.keys()) {
      if (time >= now - historyMs) continue;
      this.candles.delete(time);
      this.ema.delete(time);
      this.emaVersions.delete(time);
      this.liveTimes.delete(time);
    }
    let lastConfirmed: number | null = null;
    const sorted = [...this.candles.values()].sort((a, b) => a.time - b.time);
    const { instrumentUid, emaPeriod, timeframe } = this.selection;
    const candles = sorted.map((candle, index): ChartCandle => {
      const confirmedEma = this.ema.get(candle.time) ?? null;
      const previewEma =
        index === sorted.length - 1 &&
        !candle.complete &&
        now < candle.time + timeframeMs[timeframe] &&
        lastConfirmed !== null
          ? lastConfirmed + ((candle.close - lastConfirmed) * 2) / (emaPeriod + 1)
          : null;
      if (confirmedEma !== null) lastConfirmed = confirmedEma;
      return { ...candle, confirmedEma, previewEma };
    });
    return { instrumentUid, emaPeriod, timeframe, candles };
  }
}

class MarketFeed {
  readonly listeners = new Set<MarketListener>();
  readonly controller = new AbortController();
  history?: MarketHistory;
  state: StreamState = 'connecting';

  constructor(readonly config: MarketConfig) {}

  public matches(config: MarketConfig) {
    return this.config.token === config.token && sameMarketSelection(this.config, config);
  }

  public publish(update: MarketUpdate) {
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
  private readonly feeds = new Set<MarketFeed>();

  constructor(
    private readonly broker: MarketBroker,
    private readonly loadConfig: () => Promise<MarketConfig | null>,
    options: { now?: () => number; refreshMs?: number; retryMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? 30_000;
    this.retryMs = options.retryMs ?? 5_000;
  }

  public async history() {
    const config = await this.loadConfig();
    if (!config) return null;
    const series = new MarketSeries(config);
    await this.refresh(series, config);
    return series.history(this.now());
  }

  public async subscribe(listener: MarketListener, pinnedConfig?: MarketConfig) {
    const config = pinnedConfig ?? (await this.loadConfig());
    if (!config) {
      listener({ stream: 'unconfigured' });
      return () => {};
    }
    let feed = [...this.feeds].find((existing) => existing.matches(config));
    if (!feed) {
      feed = new MarketFeed(config);
      this.feeds.add(feed);
      void this.run(feed);
    }
    feed.listeners.add(listener);
    listener({ stream: feed.state, history: feed.history });
    return () => {
      feed.listeners.delete(listener);
      if (feed.listeners.size === 0) {
        feed.controller.abort();
        this.feeds.delete(feed);
      }
    };
  }

  private async refresh(
    series: MarketSeries,
    { token, instrumentUid, emaPeriod, timeframe }: MarketConfig,
    signal?: AbortSignal,
    onCandles?: (snapshot: BrokerSnapshot) => void,
    onEma?: () => void,
  ) {
    const now = this.now();
    const from = new Date(now - historyMs);
    const to = new Date(now);
    const candles = await this.broker.candles(token, instrumentUid, timeframe, from, to, signal);
    if (signal?.aborted) return;
    series.merge(candles);
    onCandles?.({ candles, ema: null });
    // Read the indicator after observing completion, not in parallel with that check.
    const acceptEma = series.beginEma(candles);
    const loadEma = async () => {
      const ema = candles.some((candle) => candle.complete)
        ? await this.broker
            .ema(token, instrumentUid, timeframe, emaPeriod, from, to, signal)
            .catch(() => null)
        : [];
      if (!signal?.aborted) {
        acceptEma(ema ?? []);
        onEma?.();
      }
      return { candles, ema };
    };
    if (onCandles) {
      void loadEma();
      return { candles, ema: null };
    }
    return loadEma();
  }

  private async run(feed: MarketFeed) {
    const { config, controller } = feed;
    const series = new MarketSeries(config);
    let recovering = false;
    const publishHistory = (stream = feed.state, recoveredAt?: number) => {
      const history = series.history(recoveredAt ?? this.now());
      if (stream !== feed.state || JSON.stringify(history) !== JSON.stringify(feed.history)) {
        feed.publish({ stream, history, ...(recoveredAt !== undefined && { recoveredAt }) });
      }
    };
    const poll = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        try {
          await this.refresh(
            series,
            config,
            signal,
            (snapshot) => {
              const cutoff = this.now();
              if (
                recovering &&
                hasRecoveryBaseline(snapshot, cutoff, timeframeMs[config.timeframe])
              ) {
                recovering = false;
                publishHistory('live', cutoff);
              } else publishHistory();
            },
            () => publishHistory(),
          );
        } catch {
          /* Keep the last successful snapshot and retry. */
          if (!signal.aborted && feed.history) publishHistory();
        }
        await delay(this.refreshMs, undefined, { signal }).catch(() => {});
      }
    };
    while (!controller.signal.aborted) {
      series.resetStream();
      const attempt = new AbortController();
      const signal = AbortSignal.any([attempt.signal, controller.signal]);
      let polling: Promise<void> | undefined;
      try {
        for await (const event of this.broker.stream(
          config.token,
          config.instrumentUid,
          config.timeframe,
          signal,
        )) {
          if (signal.aborted) break;
          if (event.kind === 'subscribed') {
            if (!recovering) feed.publish({ stream: 'live' });
            polling ??= poll(signal);
          } else {
            series.tick(event.candle);
            if (feed.history) publishHistory();
            else {
              const { candles, ...selection } = series.history(this.now());
              const candle = candles.find((candle) => candle.time === event.candle.time);
              if (candle) feed.publish({ stream: feed.state, tick: { ...selection, candle } });
            }
          }
        }
      } catch {
        /* The broker stream ended; reconnect below. */
      } finally {
        attempt.abort();
        if (!controller.signal.aborted) {
          recovering = true;
          const history = feed.history && {
            ...feed.history,
            candles: feed.history.candles.map((candle) =>
              candle.previewEma === null ? candle : { ...candle, previewEma: null },
            ),
          };
          feed.publish({ stream: 'disconnected', history });
        }
        await polling;
      }
      if (controller.signal.aborted) break;
      await delay(this.retryMs, undefined, { signal: controller.signal }).catch(() => {});
      if (!controller.signal.aborted) feed.publish({ stream: 'connecting' });
    }
  }
}
