import { randomUUID } from 'node:crypto';
import { crossing, positionDelta, type Side } from './crossing.js';
import { hourMs, type MarketData, type MarketUpdate } from './market-data.js';

export type TradingConfig = {
  token: string; accountId: string; instrumentUid: string; ticker: string; emaPeriod: number; lots: number;
};
export type OrderIntent = {
  id: string; accountId: string; instrumentUid: string; ticker: string;
  action: 'ema-crossing' | 'manual-close';
  candleTime: number | null; signalTime: number | null; signalPrice: number | null; ema: number | null;
  manualCloseTime: number | null;
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
  status: 'confirmed' | 'reconciled' | 'unconfirmed' | 'stopped-before-send' | 'feed-lost-before-send' | 'account-check-failed-before-send';
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
type Signal = { candleTime: number; signalTime: number; signalPrice: number; ema: number; targetPosition: number };
type Selection = Pick<TradingConfig, 'accountId' | 'instrumentUid'>;
type Recovery = { order: OrderIntent; state: BrokerOrder; verifiedPosition: number | null };

const unknownOrder: BrokerOrder = {
  brokerOrderId: null, brokerStatus: 'unknown', executedLots: null, executions: [],
};

export class Robot {
  private mode: 'stopped' | 'starting' | 'running' | 'paused' = 'stopped';
  private reason: string | null = null;
  private position: number | null = null;
  private run?: Run;
  private recovery?: Recovery;
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
    const recovery = this.recovery;
    return {
      mode: this.mode, reason: this.reason, position: this.position,
      ...(recovery && { recovery: { orderId: recovery.order.id, ready: recovery.verifiedPosition !== null } }),
    };
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

  private async requireNoUnresolved() {
    if (this.recovery || await this.store.hasUnresolved()) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
  }

  async changeSettings(action: () => Promise<void>) {
    this.requireStopped();
    this.changing = true;
    try {
      await this.requireNoUnresolved();
      await action();
      this.position = null;
      this.reason = null;
      this.publish();
    } finally {
      this.changing = false;
    }
  }

  async start() {
    this.requireStopped();
    await this.begin(async () => {
      await this.requireNoUnresolved();
      const config = await this.loadConfig();
      await this.broker.verifySelection(config);
      await this.readPosition(config, true);
      return { config, hasConfirmedEntry: false };
    });
  }

  async resume() {
    const recovery = this.requireRecovery();
    const expected = recovery.verifiedPosition;
    if (expected === null) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    await this.begin(async () => {
      const config = await this.recoveryConfig(recovery);
      await this.broker.verifySelection(config);
      const reason = await this.recheckPosition(config, expected);
      if (reason) {
        if (this.mode === 'starting') {
          recovery.verifiedPosition = null;
          this.reason = reason;
          await this.store.record(recovery.order.id, { ...recovery.state, status: 'unconfirmed', position: this.position });
        }
        throw new RobotError(reason);
      }
      return { config, hasConfirmedEntry: expected !== 0 };
    }, recovery);
  }

  private async begin(prepare: () => Promise<{ config: TradingConfig; hasConfirmedEntry: boolean }>, recovery?: Recovery) {
    const previousMode = this.mode;
    let run: Run | undefined;
    this.mode = 'starting';
    this.starting = true;
    this.position = null;
    this.publish();
    try {
      const { config, hasConfirmedEntry } = await prepare();
      if (this.mode !== 'starting') return;
      const next: Run = { config, liveSince: null, lastAttemptedCandleOpenMs: -Infinity, hasConfirmedEntry };
      this.run = run = next;
      this.reason = null;
      const unsubscribe = await this.market.subscribe(update => this.onMarket(next, update), config);
      if (this.run === next) next.unsubscribe = unsubscribe;
      else unsubscribe();
      if (this.run === next && recovery && this.recovery === recovery) {
        this.recovery = undefined;
        this.publish();
      }
    } catch (error) {
      if (this.mode === 'starting' || (run && this.run === run)) {
        this.clearRun();
        this.mode = previousMode;
        this.publish();
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    if (this.recovery?.verifiedPosition != null) this.recovery = undefined;
    else if (this.mode === 'stopped') return;
    if (this.run) this.run.cancelledBy = 'stopped-before-send';
    this.clearRun();
    this.mode = 'stopped';
    if (!this.recovery) this.reason = null;
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

  private requireRecovery() {
    if (this.starting || this.pending || this.changing || (this.mode !== 'paused' && this.mode !== 'stopped')) {
      throw new RobotError('ROBOT_BUSY');
    }
    if (!this.recovery) throw new RobotError('ROBOT_NO_ORDER_TO_RECONCILE');
    return this.recovery;
  }

  private async recoveryConfig({ order }: Recovery) {
    const config = await this.loadConfig();
    if (config.accountId !== order.accountId || config.instrumentUid !== order.instrumentUid) {
      throw new RobotError('ROBOT_SELECTION_CHANGED');
    }
    return config;
  }

  async reconcile() {
    const recovery = this.requireRecovery();
    this.pending = this.reconcileOrder(recovery).finally(() => {
      this.pending = undefined;
      this.publish();
    });
    await this.pending;
  }

  private async reconcileOrder(recovery: Recovery) {
    recovery.verifiedPosition = null;
    this.position = null;
    this.reason = 'ROBOT_ORDER_UNRESOLVED';
    const config = await this.recoveryConfig(recovery);
    const { order } = recovery;
    // Always ask with the original saved request ID, not a new order or a guessed exchange ID.
    const state = await this.broker.orderState(config.token, order, null).catch(() => null);
    const account = await this.broker.accountState(config).catch(() => null);
    const reason = orderProblem(order, state, account);
    const position = account?.position ?? null;
    this.position = position;
    recovery.state = state ?? recovery.state;
    await this.store.record(order.id, {
      ...recovery.state, position,
      status: reason ? 'unconfirmed' : state?.brokerStatus === 'filled' ? 'confirmed' : 'reconciled',
    });
    this.reason = reason;
    if (!reason) recovery.verifiedPosition = position;
  }

  async closePosition(selection: Selection) {
    this.requireStopped();
    this.pending = this.close(selection).catch(error => {
      if (!this.recovery) this.reason = error instanceof RobotError ? error.code : 'ROBOT_CLOSE_FAILED';
      throw error;
    }).finally(() => {
      this.pending = undefined;
      this.publish();
    });
    await this.pending;
  }

  private async close(selection: Selection) {
    await this.requireNoUnresolved();
    const config = await this.loadConfig();
    const { accountId, instrumentUid, ticker } = config;
    if (selection.accountId !== accountId || selection.instrumentUid !== instrumentUid) {
      throw new RobotError('ROBOT_SELECTION_CHANGED');
    }
    const fromPosition = await this.readPosition(config, false);
    this.reason = null;
    const delta = positionDelta(fromPosition, 0);
    if (!delta) return;
    const intent: OrderIntent = {
      id: randomUUID(), accountId, instrumentUid, ticker, fromPosition, targetPosition: 0, ...delta,
      action: 'manual-close', manualCloseTime: this.now(), candleTime: null, signalTime: null, signalPrice: null, ema: null,
    };
    if (!await this.store.reserve(intent)) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    this.publish();
    const accountCheckError = await this.recheckPosition(config, fromPosition);
    if (accountCheckError) {
      await this.recordNotSent(intent, 'account-check-failed-before-send');
      throw new RobotError(accountCheckError);
    }
    if (!await this.submitAndRecord(config, intent)) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
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
    if (this.recovery) return;

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
    const delta = positionDelta(fromPosition, signal.targetPosition);
    if (!delta) {
      this.publish();
      return;
    }
    const { accountId, instrumentUid, ticker } = run.config;
    const intent: OrderIntent = {
      ...signal, id: randomUUID(), accountId, instrumentUid, ticker, fromPosition, ...delta,
      action: 'ema-crossing', manualCloseTime: null,
    };
    if (!await this.store.reserve(intent)) {
      if (await this.store.hasUnresolved()) this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.publish();
    const accountCheckError = this.run === run ? await this.recheckPosition(run.config, fromPosition) : undefined;
    if (this.run !== run || accountCheckError) {
      await this.recordNotSent(intent, run.cancelledBy ?? 'account-check-failed-before-send');
      if (accountCheckError) this.pause(run, accountCheckError);
      this.publish();
      return;
    }
    if (await this.submitAndRecord(run.config, intent)) run.hasConfirmedEntry = true;
    this.publish();
  }

  private async recheckPosition(config: TradingConfig, expected: number) {
    try {
      if (await this.readPosition(config, false) !== expected) return 'ROBOT_POSITION_CHANGED';
    } catch (error) {
      return error instanceof RobotError ? error.code : 'ROBOT_POSITION_UNVERIFIED';
    }
  }

  private recordNotSent(intent: OrderIntent, status: 'stopped-before-send' | 'feed-lost-before-send' | 'account-check-failed-before-send') {
    return this.store.record(intent.id, { ...unknownOrder, status, position: this.position });
  }

  private async submitAndRecord(config: TradingConfig, intent: OrderIntent) {
    // A failed submission is ambiguous, even if the first lookup appears to settle it.
    const posted = await this.broker.submit(config.token, intent).catch(() => null);
    const state = await this.broker.orderState(config.token, intent, posted?.brokerOrderId ?? null).catch(() => null);
    const account = await this.broker.accountState(config).catch(() => null);
    const details = state ?? { ...unknownOrder, ...posted };
    const reason = !posted || posted.brokerStatus === 'unknown' ? 'ROBOT_ORDER_SUBMISSION_UNCERTAIN'
      : posted.brokerStatus === 'partial' ? 'ROBOT_ORDER_PARTIAL'
      : posted.brokerStatus === 'rejected' ? 'ROBOT_ORDER_REJECTED'
      : details.brokerStatus === 'rejected' ? 'ROBOT_ORDER_REJECTED'
      : posted.brokerStatus === 'cancelled' || details.brokerStatus === 'cancelled' ? 'ROBOT_ORDER_CANCELLED'
      : orderProblem(intent, state, account);
    this.position = account?.position ?? null;
    try {
      await this.store.record(intent.id, { ...details, position: this.position, status: reason ? 'unconfirmed' : 'confirmed' });
    } catch (error) {
      this.pauseForOrder(intent, details, reason ?? 'ROBOT_ORDER_UNRESOLVED');
      throw error;
    }
    if (reason) this.pauseForOrder(intent, details, reason);
    return !reason;
  }

  private pauseForOrder(order: OrderIntent, state: BrokerOrder, reason: string) {
    this.clearRun();
    this.recovery = { order, state, verifiedPosition: null };
    if (this.mode !== 'stopped' || order.action === 'manual-close') this.mode = 'paused';
    this.reason = reason;
    this.publish();
  }
}

function orderProblem(order: OrderIntent, state: BrokerOrder | null, account: Awaited<ReturnType<Broker['accountState']>> | null) {
  if (!state || state.brokerStatus === 'unknown') return 'ROBOT_ORDER_UNRESOLVED';
  if (state.brokerStatus === 'partial') return 'ROBOT_ORDER_PARTIAL';
  if (state.brokerStatus === 'new' || account?.activeOrders) return 'ROBOT_ACTIVE_ORDERS';
  const { executedLots, executions } = state;
  if (executedLots === null || !Number.isSafeInteger(executedLots) || executedLots < 0 || executedLots > order.lots
    || (state.brokerStatus === 'filled' && executedLots !== order.lots)
    || (state.brokerStatus === 'rejected' && executedLots !== 0)
    || executions.some(fill => !Number.isSafeInteger(fill.lots) || fill.lots <= 0)
    || executions.reduce((sum, fill) => sum + fill.lots, 0) !== executedLots) return 'ROBOT_ORDER_FILLS_UNVERIFIED';
  if (account?.position == null) return 'ROBOT_POSITION_UNVERIFIED';
  const expected = order.fromPosition + (order.direction === 'buy' ? executedLots : -executedLots);
  return account.position === expected ? null : 'ROBOT_ORDER_POSITION_MISMATCH';
}
