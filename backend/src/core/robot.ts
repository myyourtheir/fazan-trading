import { randomUUID } from 'node:crypto';
import { crossing, positionDelta, type Side } from './crossing.js';
import { hourMs, type MarketData, type MarketUpdate } from './market-data.js';

export type TradingConfig = {
  token: string; accountId: string; instrumentUid: string; ticker: string; emaPeriod: number; lots: number;
};
export type OrderIntent = {
  id: string; accountId: string; instrumentUid: string; ticker: string;
  candleTime: number; signalTime: number; signalPrice: number; ema: number;
  direction: 'buy' | 'sell'; lots: number; fromPosition: number; targetPosition: number;
};
export type Execution = { tradeId: string; lots: number; price: number | null; time: number | null };
export type BrokerOrder = {
  brokerOrderId: string | null;
  brokerStatus: 'filled' | 'rejected' | 'cancelled' | 'new' | 'partial' | 'unknown';
  executedLots: number | null;
  executions: Execution[];
};
export type OrderResult = BrokerOrder & {
  status: 'confirmed' | 'unconfirmed' | 'stopped-before-send' | 'feed-lost-before-send';
  position: number | null;
};
export type JournalEntry = OrderIntent & Omit<OrderResult, 'status'> & { status: OrderResult['status'] | 'reserved' };

export interface Broker {
  verifySelection(config: TradingConfig): Promise<void>;
  accountState(config: TradingConfig): Promise<{ position: number | null; activeOrders: boolean }>;
  submit(token: string, order: OrderIntent): Promise<Omit<BrokerOrder, 'executions'>>;
  orderState(token: string, order: OrderIntent, brokerOrderId: string | null): Promise<BrokerOrder>;
}

export interface TradingStore {
  reserve(order: OrderIntent): Promise<boolean>;
  record(id: string, result: OrderResult): Promise<void>;
  hasUnresolved(): Promise<boolean>;
  history(accountId?: string): Promise<JournalEntry[]>;
}

export class RobotError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); }
}

type Run = {
  config: TradingConfig; liveSince: number | null; lastAttemptedCandleOpenMs: number; hasConfirmedEntry: boolean;
  cancelledBy?: 'stopped-before-send' | 'feed-lost-before-send';
  unsubscribe?: () => void;
};
type Signal = Pick<OrderIntent, 'candleTime' | 'signalTime' | 'signalPrice' | 'ema' | 'targetPosition'>;

const unknownOrder: BrokerOrder = {
  brokerOrderId: null, brokerStatus: 'unknown', executedLots: null, executions: [],
};

export class Robot {
  private mode: 'stopped' | 'starting' | 'running' | 'paused' = 'stopped';
  private reason: string | null = null;
  private position: number | null = null;
  private run?: Run;
  private pending?: Promise<void>;
  private starting = false;
  private changing = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly broker: Broker,
    private readonly store: TradingStore,
    private readonly market: Pick<MarketData, 'subscribe'>,
    private readonly loadConfig: () => Promise<TradingConfig>,
    private readonly now = Date.now,
  ) {}

  status() {
    return { mode: this.mode, reason: this.reason, position: this.position };
  }

  history(accountId?: string) { return this.store.history(accountId); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish() { for (const listener of this.listeners) listener(); }

  private requireStopped() {
    if (this.mode !== 'stopped' || this.starting || this.pending || this.changing) throw new RobotError('ROBOT_BUSY');
  }

  async changeSettings(action: () => Promise<void>) {
    this.requireStopped();
    this.changing = true;
    try {
      await action();
      this.position = null;
      this.publish();
    } finally {
      this.changing = false;
    }
  }

  async start() {
    this.requireStopped();
    this.mode = 'starting';
    this.starting = true;
    this.position = null;
    this.publish();
    try {
      if (await this.store.hasUnresolved()) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
      const config = await this.loadConfig();
      await this.broker.verifySelection(config);
      await this.readPosition(config, true);
      if (this.mode !== 'starting') return;
      const run: Run = { config, liveSince: null, lastAttemptedCandleOpenMs: -Infinity, hasConfirmedEntry: false };
      this.run = run;
      const unsubscribe = await this.market.subscribe(update => this.onMarket(run, update), config);
      if (this.run === run) run.unsubscribe = unsubscribe;
      else unsubscribe();
    } catch (error) {
      if (this.mode === 'starting') this.stop();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    if (this.run) this.run.cancelledBy = 'stopped-before-send';
    this.clearRun();
    this.mode = 'stopped';
    this.reason = null;
    this.publish();
  }

  private clearRun() {
    this.run?.unsubscribe?.();
    this.run = undefined;
  }

  async shutdown() {
    this.stop();
    await this.pending;
  }

  private pause(run: Run, reason: string) {
    if (this.run !== run) return;
    this.clearRun();
    this.mode = 'paused';
    this.reason = reason;
    this.publish();
  }

  private async readPosition(config: TradingConfig, requireFlat: boolean) {
    this.position = null;
    const { position, activeOrders } = await this.broker.accountState(config);
    this.position = position;
    if (activeOrders) throw new RobotError('ROBOT_ACTIVE_ORDERS');
    if (position === null) throw new RobotError('ROBOT_POSITION_UNVERIFIED');
    if (requireFlat && position !== 0) throw new RobotError('ROBOT_POSITION_NOT_FLAT');
    return position;
  }

  private onMarket(run: Run, { stream, history }: MarketUpdate) {
    if (this.run !== run) return;
    if (stream === 'disconnected' || stream === 'unconfigured') {
      run.cancelledBy = 'feed-lost-before-send';
      return this.pause(run, 'ROBOT_FEED_LOST');
    }
    if (stream !== 'live') return;
    const since = run.liveSince ??= this.now();
    if (!history || this.pending) return;
    if (history.instrumentUid !== run.config.instrumentUid || history.emaPeriod !== run.config.emaPeriod) return;
    if (this.mode === 'starting') {
      this.mode = 'running';
      this.publish();
    }

    const now = this.now();
    let side: Side | null = null;
    let historicalEmaPending = false;
    // Feed snapshots are ordered by opening time. Rebuild the history baseline on each snapshot:
    // a late EMA can change the strict side before a later equality.
    for (const candle of history.candles) {
      const signalTime = candle.time + hourMs;
      if (!candle.complete || signalTime > now) continue;
      if (candle.confirmedEma === null) {
        if (signalTime > since) break; // Wait for this live close before considering later ones.
        historicalEmaPending = true;
        continue;
      }
      if (signalTime > since && historicalEmaPending) break;
      const next = crossing(side, candle.close, candle.confirmedEma);
      side = next.side;
      if (candle.close !== candle.confirmedEma) historicalEmaPending = false;
      if (!next.direction || signalTime <= since || candle.time <= run.lastAttemptedCandleOpenMs) continue;
      run.lastAttemptedCandleOpenMs = candle.time;
      const signal: Signal = {
        candleTime: candle.time,
        signalTime, signalPrice: candle.close, ema: candle.confirmedEma,
        targetPosition: next.direction * run.config.lots,
      };
      this.pending = this.trade(run, signal).catch(error => {
        this.pause(run, error instanceof RobotError ? error.code : 'ROBOT_TRADE_FAILED');
      }).finally(() => { this.pending = undefined; });
      break;
    }
  }

  private async trade(run: Run, signal: Signal) {
    const fromPosition = await this.readPosition(run.config, !run.hasConfirmedEntry);
    if (this.run !== run) return;
    if (fromPosition === signal.targetPosition) {
      this.publish();
      return;
    }
    const { accountId, instrumentUid, ticker } = run.config;
    const intent: OrderIntent = {
      ...signal, id: randomUUID(), accountId, instrumentUid, ticker, fromPosition,
      ...positionDelta(fromPosition, signal.targetPosition),
    };
    if (!await this.store.reserve(intent)) {
      if (await this.store.hasUnresolved()) this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.publish();
    if (this.run !== run) {
      await this.store.record(intent.id, { ...unknownOrder, status: run.cancelledBy ?? 'stopped-before-send', position: this.position });
      this.publish();
      return;
    }
    const result = await settleOrder(this.broker, run.config, intent);
    this.position = result.position;
    await this.store.record(intent.id, result);
    if (result.status === 'confirmed') run.hasConfirmedEntry = true;
    else this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
    this.publish();
  }
}

async function settleOrder(broker: Broker, config: TradingConfig, order: OrderIntent): Promise<OrderResult> {
  // A failed response is ambiguous. Look up the original request; never send a new order.
  const posted = await broker.submit(config.token, order).catch(() => unknownOrder);
  const state = await broker.orderState(config.token, order, posted.brokerOrderId)
    .catch(() => ({ ...posted, executions: [] }));
  const account = await broker.accountState(config).catch(() => null);
  const confirmed = state.brokerStatus === 'filled' && state.executedLots === order.lots
    && state.executions.reduce((sum, fill) => sum + fill.lots, 0) === order.lots
    && account?.position === order.targetPosition && !account.activeOrders;
  return { ...state, status: confirmed ? 'confirmed' : 'unconfirmed', position: account?.position ?? null };
}
