import { randomUUID } from 'node:crypto';
import { findLiveCrossing, positionDelta } from './crossing.js';
import {
  sameMarketSelection,
  type MarketData,
  type MarketHistory,
  type MarketSelection,
  type MarketUpdate,
} from './market-data.js';
import type { Timeframe } from './timeframe.js';

export type TradingConfig = MarketSelection & {
  token: string;
  accountId: string;
  ticker: string;
  lots: number;
};
export type OrderIntent = {
  id: string;
  accountId: string;
  instrumentUid: string;
  ticker: string;
  timeframe: Timeframe;
  action: 'ema-crossing' | 'manual-close';
  candleTime: number | null;
  signalTime: number | null;
  signalPrice: number | null;
  ema: number | null;
  manualCloseTime: number | null;
  direction: 'buy' | 'sell';
  lots: number;
  fromPosition: number;
  targetPosition: number;
};
export type Execution = {
  tradeId: string;
  lots: number;
  price: number | null;
  time: number | null;
};
export type BrokerOrder = {
  brokerOrderId: string | null;
  brokerStatus: 'filled' | 'rejected' | 'cancelled' | 'new' | 'partial' | 'unknown';
  executedLots: number | null;
  executions: Execution[];
};
export type OrderResult = BrokerOrder & {
  status:
    | 'confirmed'
    | 'reconciled'
    | 'unconfirmed'
    | 'stopped-before-send'
    | 'feed-lost-before-send'
    | 'account-check-failed-before-send';
  position: number | null;
};
export type JournalEntry = OrderIntent &
  Omit<OrderResult, 'status'> & { status: OrderResult['status'] | 'reserved' };

export interface Broker {
  verifySelection(config: TradingConfig): Promise<void>;
  accountState(config: TradingConfig): Promise<{ position: number | null; activeOrders: boolean }>;
  // A definite rejection before creating an order is rejected, with no broker ID and zero lots. Ambiguous failures throw.
  submit(token: string, order: OrderIntent): Promise<Omit<BrokerOrder, 'executions'>>;
  orderState(token: string, order: OrderIntent, brokerOrderId: string | null): Promise<BrokerOrder>;
}

export interface TradingStore {
  reserve(order: OrderIntent): Promise<boolean>;
  record(id: string, result: OrderResult): Promise<void>;
  hasUnresolved(): Promise<boolean>;
  unresolved(): Promise<JournalEntry | null>;
  history(accountId?: string): Promise<JournalEntry[]>;
}

export class RobotError extends Error {
  readonly status = 409;
  constructor(readonly code: string) {
    super(code);
  }
}

type LiveSession = { since: number; queued?: MarketHistory };
type Run = {
  config: TradingConfig;
  session?: LiveSession;
  lastAttemptedCandleOpenMs: number;
  hasConfirmedEntry: boolean;
  stopped?: boolean;
  unsubscribe?: () => void;
};
type Signal = {
  candleTime: number;
  signalTime: number;
  signalPrice: number;
  ema: number;
  targetPosition: number;
};
type Selection = Pick<TradingConfig, 'accountId' | 'instrumentUid'>;
type Recovery = {
  order: OrderIntent;
  state: BrokerOrder;
  rejectedBeforeAcceptance: boolean;
  verifiedPosition: number | null;
};

const unknownOrder: BrokerOrder = {
  brokerOrderId: null,
  brokerStatus: 'unknown',
  executedLots: null,
  executions: [],
};

export class Robot {
  private mode: 'stopped' | 'starting' | 'running' | 'reconnecting' | 'paused' = 'stopped';
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
      mode: this.mode,
      reason: this.reason,
      position: this.position,
      ...(recovery && {
        recovery: { orderId: recovery.order.id, ready: recovery.verifiedPosition !== null },
      }),
    };
  }

  history(accountId?: string) {
    return this.store.history(accountId);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }

  private requireStopped() {
    if (this.mode !== 'stopped' || this.starting || this.pending || this.changing)
      throw new RobotError('ROBOT_BUSY');
  }

  private async requireNoUnresolved() {
    if (this.recovery || (await this.store.hasUnresolved()))
      throw new RobotError('ROBOT_ORDER_UNRESOLVED');
  }

  async changeSettings(action: () => Promise<void>) {
    await this.withSettingsLock(async () => {
      await this.requireNoUnresolved();
      await action();
      this.position = null;
      this.reason = null;
    });
  }

  async replaceCredentials(action: (accountId?: string) => Promise<void>) {
    await this.withSettingsLock(async () => {
      const order = this.recovery?.order ?? (await this.store.unresolved());
      await action(order?.accountId);
      if (!order) {
        this.position = null;
        this.reason = null;
      }
    });
  }

  private async withSettingsLock(action: () => Promise<void>) {
    this.requireStopped();
    this.changing = true;
    try {
      await action();
      this.publish();
    } finally {
      this.changing = false;
    }
  }

  async restore() {
    this.requireStopped();
    await this.runMaintenance(this.restoreStopped());
  }

  private async restoreStopped() {
    const order = await this.store.unresolved();
    if (order) {
      const { brokerOrderId, brokerStatus, executedLots, executions } = order;
      this.recovery = {
        order,
        state: { brokerOrderId, brokerStatus, executedLots, executions },
        verifiedPosition: null,
        rejectedBeforeAcceptance:
          brokerOrderId === null && brokerStatus === 'rejected' && executedLots === 0,
      };
      this.reason = 'ROBOT_ORDER_UNRESOLVED';
    }
    this.position = null;
    // A fresh installation (or an unreadable credential) must still allow owner login.
    const config = await this.loadConfig().catch(() => null);
    if (!config) return;
    if (this.recovery) {
      if (!sameSelection(config, this.recovery.order)) {
        this.reason = 'ROBOT_SELECTION_CHANGED';
        return;
      }
      await this.reconcileOrder(this.recovery, config);
    } else {
      this.reason = await this.readPosition(config, false).then(
        () => null,
        (error) => (error instanceof RobotError ? error.code : 'ROBOT_POSITION_UNVERIFIED'),
      );
    }
  }

  async start() {
    this.requireStopped();
    await this.beginTradingRun(async () => {
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
    await this.beginTradingRun(async () => {
      const config = await this.recoveryConfig(recovery);
      await this.broker.verifySelection(config);
      const reason = await this.recheckPosition(config, expected);
      if (reason) {
        if (this.recovery === recovery) {
          recovery.verifiedPosition = null;
          this.reason = reason;
          try {
            await this.store.record(recovery.order.id, {
              ...recovery.state,
              status: 'unconfirmed',
              position: this.position,
            });
          } finally {
            this.publish();
          }
        }
        throw new RobotError(reason);
      }
      return { config, hasConfirmedEntry: expected !== 0 };
    }, recovery);
  }

  private async beginTradingRun(
    prepare: () => Promise<{ config: TradingConfig; hasConfirmedEntry: boolean }>,
    recovery?: Recovery,
  ) {
    const previousMode = this.mode;
    let run: Run | undefined;
    this.mode = 'starting';
    this.starting = true;
    this.position = null;
    this.publish();
    try {
      const { config, hasConfirmedEntry } = await prepare();
      if (this.mode !== 'starting') {
        this.publish();
        return;
      }
      const next: Run = { config, lastAttemptedCandleOpenMs: -Infinity, hasConfirmedEntry };
      this.run = run = next;
      this.reason = null;
      const unsubscribe = await this.market.subscribe(
        (update) => this.onMarket(next, update),
        config,
      );
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
    if (!this.starting && !this.pending && this.recovery?.verifiedPosition != null)
      this.recovery = undefined;
    else if (this.mode === 'stopped') return;
    if (this.run) this.run.stopped = true;
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
    if (
      this.starting ||
      this.pending ||
      this.changing ||
      (this.mode !== 'paused' && this.mode !== 'stopped')
    ) {
      throw new RobotError('ROBOT_BUSY');
    }
    if (!this.recovery) throw new RobotError('ROBOT_NO_ORDER_TO_RECONCILE');
    return this.recovery;
  }

  private async recoveryConfig({ order }: Recovery) {
    const config = await this.loadConfig();
    if (!sameSelection(config, order)) {
      throw new RobotError('ROBOT_SELECTION_CHANGED');
    }
    return config;
  }

  async reconcile() {
    const recovery = this.requireRecovery();
    await this.runMaintenance(this.reconcileOrder(recovery));
  }

  private async reconcileOrder(recovery: Recovery, restoredConfig?: TradingConfig) {
    recovery.verifiedPosition = null;
    this.position = null;
    this.reason = 'ROBOT_ORDER_UNRESOLVED';
    const config = restoredConfig ?? (await this.recoveryConfig(recovery));
    const { order } = recovery;
    // Always ask with the original saved request ID, not a new order or a guessed exchange ID.
    const { state: lookup, account } = await this.readOrderAndAccount(config, order, null);
    if (lookup && lookup.brokerStatus !== 'rejected') recovery.rejectedBeforeAcceptance = false;
    // The post RPC itself can definitively reject the request before creating a lookup record.
    const state = lookup ?? (recovery.rejectedBeforeAcceptance ? recovery.state : null);
    const reason = orderProblem(order, state, account);
    const position = account?.position ?? null;
    this.position = position;
    recovery.state = state ?? recovery.state;
    await this.store.record(order.id, {
      ...recovery.state,
      position,
      status: reason
        ? 'unconfirmed'
        : state?.brokerStatus === 'filled'
          ? 'confirmed'
          : 'reconciled',
    });
    this.reason = reason;
    if (!reason) recovery.verifiedPosition = position;
  }

  async closePosition(selection: Selection) {
    this.requireStopped();
    await this.runMaintenance(
      this.close(selection).catch((error) => {
        if (!this.recovery)
          this.reason = error instanceof RobotError ? error.code : 'ROBOT_CLOSE_FAILED';
        throw error;
      }),
    );
  }

  private async runMaintenance(operation: Promise<void>) {
    this.pending = operation.finally(() => {
      this.pending = undefined;
      this.publish();
    });
    await this.pending;
  }

  private async close(selection: Selection) {
    await this.requireNoUnresolved();
    const config = await this.loadConfig();
    const { accountId, instrumentUid, ticker, timeframe } = config;
    if (!sameSelection(config, selection)) {
      throw new RobotError('ROBOT_SELECTION_CHANGED');
    }
    const fromPosition = await this.readPosition(config, false);
    this.reason = null;
    const delta = positionDelta(fromPosition, 0);
    if (!delta) return;
    const intent: OrderIntent = {
      id: randomUUID(),
      accountId,
      instrumentUid,
      ticker,
      timeframe,
      fromPosition,
      targetPosition: 0,
      ...delta,
      action: 'manual-close',
      manualCloseTime: this.now(),
      candleTime: null,
      signalTime: null,
      signalPrice: null,
      ema: null,
    };
    if (!(await this.store.reserve(intent))) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    this.publish();
    const accountCheckError = await this.recheckPosition(config, fromPosition);
    if (accountCheckError) {
      await this.recordNotSent(intent, 'account-check-failed-before-send');
      throw new RobotError(accountCheckError);
    }
    if (!(await this.submitAndRecord(config, intent)))
      throw new RobotError('ROBOT_ORDER_UNRESOLVED');
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

  private onMarket(run: Run, { stream, history, recoveredAt }: MarketUpdate) {
    if (this.run !== run) return;
    if (stream === 'unconfigured') return this.pause(run, 'ROBOT_FEED_LOST');
    if (stream === 'disconnected' || (stream === 'connecting' && run.session)) {
      run.session = undefined;
      this.mode = 'reconnecting';
      this.reason = 'ROBOT_FEED_LOST';
      this.publish();
      return;
    }
    if (stream !== 'live') return;
    if (history && !sameMarketSelection(history, run.config)) return;
    const reconnecting = this.mode === 'reconnecting';
    const since = reconnecting ? recoveredAt : (run.session?.since ?? this.now());
    if (since === undefined || (reconnecting && !history)) return;
    const session = (run.session ??= { since });
    if (!history) return;
    if (this.mode === 'starting' || this.mode === 'reconnecting') {
      this.mode = 'running';
      this.reason = null;
      this.publish();
    }
    if (this.recovery) return;
    if (this.pending) {
      session.queued = history;
      return;
    }
    session.queued = undefined;
    const crossing = findLiveCrossing(history, {
      since: session.since,
      now: this.now(),
      lastAttempted: run.lastAttemptedCandleOpenMs,
    });
    if (!crossing) return;
    const { direction, ...signal } = crossing;
    run.lastAttemptedCandleOpenMs = signal.candleTime;
    this.pending = this.trade(run, session, {
      ...signal,
      targetPosition: direction * run.config.lots,
    })
      .catch((error) => {
        this.pause(run, error instanceof RobotError ? error.code : 'ROBOT_TRADE_FAILED');
      })
      .finally(() => {
        this.pending = undefined;
        const queued = run.session?.queued;
        if (queued && this.run === run) this.onMarket(run, { stream: 'live', history: queued });
      });
  }

  private async trade(run: Run, session: LiveSession, signal: Signal) {
    const stillLive = () => this.run === run && run.session === session;
    const fromPosition = await this.readPosition(run.config, !run.hasConfirmedEntry).catch(
      (error) => {
        if (stillLive()) throw error;
        return null;
      },
    );
    if (fromPosition === null || !stillLive()) return;
    const delta = positionDelta(fromPosition, signal.targetPosition);
    if (!delta) {
      this.publish();
      return;
    }
    const { accountId, instrumentUid, ticker, timeframe } = run.config;
    const intent: OrderIntent = {
      ...signal,
      id: randomUUID(),
      accountId,
      instrumentUid,
      ticker,
      timeframe,
      fromPosition,
      ...delta,
      action: 'ema-crossing',
      manualCloseTime: null,
    };
    if (!(await this.store.reserve(intent))) {
      if (await this.store.hasUnresolved()) this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.publish();
    const accountCheckError = stillLive()
      ? await this.recheckPosition(run.config, fromPosition)
      : undefined;
    if (!stillLive() || accountCheckError) {
      const cancelled = run.stopped ? 'stopped-before-send' : 'feed-lost-before-send';
      await this.recordNotSent(
        intent,
        stillLive() ? 'account-check-failed-before-send' : cancelled,
      );
      if (accountCheckError && stillLive()) this.pause(run, accountCheckError);
      this.publish();
      return;
    }
    if (await this.submitAndRecord(run.config, intent)) run.hasConfirmedEntry = true;
    this.publish();
  }

  private async recheckPosition(config: TradingConfig, expected: number) {
    try {
      if ((await this.readPosition(config, false)) !== expected) return 'ROBOT_POSITION_CHANGED';
    } catch (error) {
      return error instanceof RobotError ? error.code : 'ROBOT_POSITION_UNVERIFIED';
    }
  }

  private recordNotSent(
    intent: OrderIntent,
    status: 'stopped-before-send' | 'feed-lost-before-send' | 'account-check-failed-before-send',
  ) {
    return this.store.record(intent.id, { ...unknownOrder, status, position: this.position });
  }

  private async readOrderAndAccount(
    config: TradingConfig,
    order: OrderIntent,
    brokerOrderId: string | null,
  ) {
    const state = await this.broker
      .orderState(config.token, order, brokerOrderId)
      .catch(() => null);
    const account = await this.broker.accountState(config).catch(() => null);
    return { state, account };
  }

  private async submitAndRecord(config: TradingConfig, intent: OrderIntent) {
    // A failed submission is ambiguous, even if the first lookup appears to settle it.
    const posted = await this.broker.submit(config.token, intent).catch(() => null);
    const { state, account } = await this.readOrderAndAccount(
      config,
      intent,
      posted?.brokerOrderId ?? null,
    );
    const details = state ?? { ...unknownOrder, ...posted };
    const rejectedBeforeAcceptance =
      posted?.brokerStatus === 'rejected' &&
      posted.brokerOrderId === null &&
      posted.executedLots === 0 &&
      (!state || state.brokerStatus === 'rejected');
    const reason =
      !posted || posted.brokerStatus === 'unknown'
        ? 'ROBOT_ORDER_SUBMISSION_UNCERTAIN'
        : posted.brokerStatus === 'partial'
          ? 'ROBOT_ORDER_PARTIAL'
          : posted.brokerStatus === 'rejected'
            ? 'ROBOT_ORDER_REJECTED'
            : details.brokerStatus === 'rejected'
              ? 'ROBOT_ORDER_REJECTED'
              : posted.brokerStatus === 'cancelled' || details.brokerStatus === 'cancelled'
                ? 'ROBOT_ORDER_CANCELLED'
                : orderProblem(intent, state, account);
    this.position = account?.position ?? null;
    try {
      await this.store.record(intent.id, {
        ...details,
        position: this.position,
        status: reason ? 'unconfirmed' : 'confirmed',
      });
    } catch (error) {
      this.pauseForOrder(
        intent,
        details,
        rejectedBeforeAcceptance,
        reason ?? 'ROBOT_ORDER_UNRESOLVED',
      );
      throw error;
    }
    if (reason) this.pauseForOrder(intent, details, rejectedBeforeAcceptance, reason);
    return !reason;
  }

  private pauseForOrder(
    order: OrderIntent,
    state: BrokerOrder,
    rejectedBeforeAcceptance: boolean,
    reason: string,
  ) {
    this.clearRun();
    this.recovery = { order, state, rejectedBeforeAcceptance, verifiedPosition: null };
    if (this.mode !== 'stopped' || order.action === 'manual-close') this.mode = 'paused';
    this.reason = reason;
    this.publish();
  }
}

function sameSelection(a: Selection, b: Selection) {
  return a.accountId === b.accountId && a.instrumentUid === b.instrumentUid;
}

function orderProblem(
  order: OrderIntent,
  state: BrokerOrder | null,
  account: Awaited<ReturnType<Broker['accountState']>> | null,
) {
  if (!state || state.brokerStatus === 'unknown') return 'ROBOT_ORDER_UNRESOLVED';
  if (state.brokerStatus === 'partial') return 'ROBOT_ORDER_PARTIAL';
  if (state.brokerStatus === 'new' || account?.activeOrders) return 'ROBOT_ACTIVE_ORDERS';
  const { executedLots, executions } = state;
  if (
    executedLots === null ||
    !Number.isSafeInteger(executedLots) ||
    executedLots < 0 ||
    executedLots > order.lots ||
    (state.brokerStatus === 'filled' && executedLots !== order.lots) ||
    (state.brokerStatus === 'rejected' && executedLots !== 0) ||
    executions.some((fill) => !Number.isSafeInteger(fill.lots) || fill.lots <= 0) ||
    executions.reduce((sum, fill) => sum + fill.lots, 0) !== executedLots
  )
    return 'ROBOT_ORDER_FILLS_UNVERIFIED';
  if (account?.position == null) return 'ROBOT_POSITION_UNVERIFIED';
  const expected = order.fromPosition + (order.direction === 'buy' ? executedLots : -executedLots);
  return account.position === expected ? null : 'ROBOT_ORDER_POSITION_MISMATCH';
}
