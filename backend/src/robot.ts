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
  status: 'confirmed' | 'unconfirmed' | 'not-sent';
  position: number | null;
};
export type JournalEntry = OrderIntent & Omit<OrderResult, 'status'> & { status: OrderResult['status'] | 'reserved' };

export interface Broker {
  verifySelection(config: TradingConfig): Promise<void>;
  accountState(config: TradingConfig): Promise<{ position: number; activeOrders: boolean }>;
  submit(token: string, order: OrderIntent): Promise<Omit<BrokerOrder, 'executions'>>;
  orderState(token: string, order: OrderIntent, brokerOrderId: string | null): Promise<BrokerOrder>;
}

export interface TradingStore {
  reserve(order: OrderIntent): Promise<boolean>;
  record(id: string, result: OrderResult): Promise<void>;
  hasUnresolved(): Promise<boolean>;
  history(): Promise<JournalEntry[]>;
}

export class RobotError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); }
}

type Run = {
  config: TradingConfig; liveSince: number | null; side: Side | null; cursor: number; entered: boolean;
  unsubscribe?: () => void;
};

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

  history() { return this.store.history(); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish() { for (const listener of this.listeners) listener(); }

  async changeSettings(action: () => Promise<void>) {
    if (this.mode !== 'stopped' || this.starting || this.pending || this.changing) throw new RobotError('ROBOT_BUSY');
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
    if (this.mode !== 'stopped' || this.starting || this.pending || this.changing) throw new RobotError('ROBOT_BUSY');
    this.mode = 'starting';
    this.starting = true;
    this.position = null;
    this.publish();
    try {
      if (await this.store.hasUnresolved()) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
      const config = await this.loadConfig();
      await this.broker.verifySelection(config);
      await this.requireFlat(config);
      if (this.mode !== 'starting') return;
      const run: Run = { config, liveSince: null, side: null, cursor: -Infinity, entered: false };
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

  private async requireFlat(config: TradingConfig) {
    this.position = null;
    const { position, activeOrders } = await this.broker.accountState(config);
    this.position = position;
    if (activeOrders) throw new RobotError('ROBOT_ACTIVE_ORDERS');
    if (position !== 0) throw new RobotError('ROBOT_POSITION_NOT_FLAT');
  }

  private onMarket(run: Run, { stream, history }: MarketUpdate) {
    if (this.run !== run) return;
    if (stream === 'disconnected' || stream === 'unconfigured') return this.pause(run, 'ROBOT_FEED_LOST');
    if (stream !== 'live') return;
    const since = run.liveSince ??= this.now();
    if (!history || run.entered || this.pending) return;
    if (history.instrumentUid !== run.config.instrumentUid || history.emaPeriod !== run.config.emaPeriod) return;
    if (this.mode === 'starting') {
      this.mode = 'running';
      this.publish();
    }

    const now = this.now();
    const closed = history.candles.filter(candle => candle.complete && candle.time + hourMs <= now);
    const latest = closed.at(-1)?.time;
    for (const candle of closed) {
      if (candle.time <= run.cursor) continue;
      const signalTime = candle.time + hourMs;
      if (candle.confirmedEma === null) {
        // Don't infer a crossing across an unconfirmed live close that has already been superseded.
        if (signalTime > since && candle.time !== latest) {
          run.side = null;
          run.cursor = candle.time;
        }
        continue;
      }
      const { side, direction } = crossing(run.side, candle.close, candle.confirmedEma);
      run.side = side;
      run.cursor = candle.time;
      // Old candles set the baseline even when their EMA arrives after Start.
      if (!direction || signalTime <= since || candle.time !== latest || now - signalTime >= hourMs) continue;
      const { accountId, instrumentUid, ticker, lots } = run.config;
      const targetPosition = direction * lots;
      const intent: OrderIntent = {
        id: randomUUID(), accountId, instrumentUid, ticker, candleTime: candle.time,
        signalTime, signalPrice: candle.close, ema: candle.confirmedEma,
        ...positionDelta(0, targetPosition), fromPosition: 0, targetPosition,
      };
      this.pending = this.enter(run, intent).catch(error => {
        this.pause(run, error instanceof RobotError ? error.code : 'ROBOT_ENTRY_FAILED');
      }).finally(() => { this.pending = undefined; });
    }
  }

  private async enter(run: Run, intent: OrderIntent) {
    await this.requireFlat(run.config);
    if (this.run !== run) return;
    if (!await this.store.reserve(intent)) {
      if (await this.store.hasUnresolved()) this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.publish();
    if (this.run !== run || this.now() - intent.signalTime >= hourMs) {
      await this.store.record(intent.id, { ...unknownOrder, status: 'not-sent', position: this.position });
      this.publish();
      return;
    }
    const result = await settleOrder(this.broker, run.config, intent);
    this.position = result.position;
    await this.store.record(intent.id, result);
    if (result.status === 'confirmed') run.entered = true;
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
