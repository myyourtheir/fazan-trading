import { randomUUID } from 'node:crypto';
import { journalPositionDelta } from './position.js';
import type { MarketHistory } from './market-data.js';
import { timeframeMs, type Timeframe } from './timeframe.js';
import {
  addOnDue,
  entryLots,
  gapAgainstPosition,
  initialIndicators,
  observeCompleted,
  openImprovedPosition,
  trailStop,
  type ImprovedPosition,
  type IndicatorState,
} from './improved-surfing.js';
import { validImproved, type ImprovedParameters } from './strategy-settings.js';
import type {
  CloseLink,
  CloseProofRef,
  EntryBeforeSendStatus,
  GuardedEntry,
  LinkedOrder,
  ProtectionTransactions,
  StopPlan,
  StoredProtection,
} from './protection-transactions.js';

export type TradingConfig = {
  instrumentUid: string;
  timeframe: Timeframe;
  token: string;
  accountId: string;
  ticker: string;
};
export type RecoveryAccount = Pick<TradingConfig, 'token' | 'accountId' | 'instrumentUid'>;
export type OrderContext =
  | {
      type: 'signal';
      candleTime: number;
      signalTime: number;
      strategy: { kind: string; [key: string]: unknown };
    }
  | { type: 'manual-close'; time: number };
export type OrderIntent = {
  id: string;
  accountId: string;
  instrumentUid: string;
  ticker: string;
  timeframe: Timeframe;
  context: OrderContext;
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
    | 'account-check-failed-before-send'
    | 'stale-signal-before-send'
    | 'session-check-failed-before-send'
    | 'session-ended-before-send';
  position: number | null;
};
export type RecoveredOrder = OrderIntent &
  Omit<OrderResult, 'status'> & {
    status: OrderResult['status'] | 'reserved';
    protectionLink?: CloseLink;
    orderVersion?: number;
  };
export type LiveSignal = {
  candleTime: number;
  signalTime: number;
  targetPosition: number;
  strategy: { kind: string; [key: string]: unknown };
};
export type FeedHistory = { instrumentUid: string; timeframe: Timeframe };
export type FeedUpdate<H> = {
  stream: 'unconfigured' | 'connecting' | 'live' | 'disconnected';
  history?: H;
  recoveredAt?: number;
  // Explicitly identifies a newly completed candle; a history snapshot alone never trades.
  freshCandleTime?: number;
  // Explicit live opening; neither a backfill nor another update to this candle is an opening.
  openedCandleTime?: number;
};
export type ProtectionState = 'confirmed' | 'unconfirmed' | 'not-sent' | 'rejected' | 'absent';
// A lookup is evidence about the original stop, not a submission result. In
// particular, a triggered stop can leave a separately executable child order.
export type ProtectionObservation =
  | { status: 'active' }
  | { status: 'triggered'; childId: string; childStatus: 'active' | 'terminal' | 'unknown' }
  | { status: 'cancelled' }
  | { status: 'absent' }
  | { status: 'unknown' };
export type ProtectionCloseObservation =
  // Definitive history for this stop, not just a current list of active orders.
  | { status: 'never-triggered' }
  // The broker must prove this is the complete set and the parent cannot create more.
  | { status: 'triggered'; childIds: string[] }
  | { status: 'unknown' };
export type Protection = {
  id: string;
  accountId: string;
  instrumentUid: string;
  direction: 'buy' | 'sell';
  lots: number;
  stop: number;
  state: ProtectionState;
  observation?: ProtectionObservation;
  closeObservation?: ProtectionCloseObservation;
  cancellationPending?: boolean;
  childIds?: string[];
  childObservations?: Record<string, { terminal: boolean; executedLots: number | null }>;
  evidenceConflict?: boolean;
};
export interface ImprovedProtection {
  submit(
    config: TradingConfig,
    protection: Protection,
  ): Promise<'confirmed' | 'not-sent' | 'rejected' | 'unconfirmed'>;
  lookup(config: RecoveryAccount, protection: Protection): Promise<ProtectionObservation>;
  // Broker observations only; persistence belongs to the transaction port.
  cancel?(config: RecoveryAccount, protection: Protection): Promise<void>;
  closeEvidence?(
    config: RecoveryAccount,
    protection: Protection,
  ): Promise<ProtectionCloseObservation>;
  childEvidence?(
    config: RecoveryAccount,
    protection: Protection,
    childId: string,
  ): Promise<{ terminal: boolean; executedLots: number | null }>;
  sizing(config: TradingConfig): Promise<{ freeMoney: number; pointValue: number }>;
  // Broker margin check for the entire proposed increase, not the entry sizing formula.
  canIncrease?(config: TradingConfig, order: OrderIntent): Promise<boolean>;
}
export type ImprovedLive = {
  parameters: ImprovedParameters;
  protection: ImprovedProtection;
  // The returned interval is the instrument's trading session containing the signal.
  session(
    config: TradingConfig,
    signalTime: number,
  ): Promise<{ start: number; end: number } | null>;
};
export interface TradingFeed<C, H> {
  subscribe(listener: (update: FeedUpdate<H>) => void, config: C): Promise<() => void>;
}
export type FindSignal<C extends TradingConfig = TradingConfig, H = MarketHistory> = (
  history: H,
  options: { since: number; now: number; lastAttempted: number },
  config: C,
) => LiveSignal | undefined;

export interface Broker {
  verifySelection(config: TradingConfig): Promise<void>;
  accountState(
    config: RecoveryAccount,
  ): Promise<{ position: number | null; activeOrders: boolean }>;
  // A definite rejection before creating an order is rejected, with no broker ID and zero lots. Ambiguous failures throw.
  submit(token: string, order: OrderIntent): Promise<Omit<BrokerOrder, 'executions'>>;
  orderState(token: string, order: OrderIntent, brokerOrderId: string | null): Promise<BrokerOrder>;
}

export interface TradingStore<HistoryEntry = unknown> {
  protection?: ProtectionTransactions;
  reserve(order: OrderIntent): Promise<boolean>;
  record(id: string, result: OrderResult): Promise<void>;
  hasUnresolved(): Promise<boolean>;
  unresolved(): Promise<RecoveredOrder | null>;
  history(accountId?: string): Promise<HistoryEntry[]>;
}

export class RobotError extends Error {
  readonly status = 409;
  constructor(readonly code: string) {
    super(code);
  }
}

type LiveSession<H> = {
  since: number;
  queued?: H;
  queuedFresh?: number;
  queuedOpen?: MarketHistory['candles'][number];
  checkDeferredClose?: boolean;
  revision?: number;
  snapshotSeen?: boolean;
  latestCompleted?: number;
  indicators?: {
    anchor: IndicatorState;
    anchorTime: number;
    candles: Map<number, MarketHistory['candles'][number]>;
    incomplete: Set<number>;
    invalid: boolean;
  };
};
type Run<C extends TradingConfig, H> = {
  config: C;
  session?: LiveSession<H>;
  lastAttemptedCandleOpenMs: number;
  hasConfirmedEntry: boolean;
  stopped?: boolean;
  unsubscribe?: () => void;
  lastOpened?: number;
  blockedThrough?: number;
  reconnect?: { history: H; cutoff: number; generation: number };
  reconnectGeneration?: number;
  improvedPosition?: ImprovedPosition;
  deferredClose?: {
    id: string;
    reverse?: { signal: LiveSignal; revision: number; hours: { start: number; end: number } };
  };
};
type Selection = Pick<TradingConfig, 'accountId' | 'instrumentUid'>;
type Recovery = {
  order: OrderIntent;
  linkedClose?: true;
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

export class Robot<
  C extends TradingConfig = TradingConfig,
  HistoryEntry = unknown,
  H extends FeedHistory = MarketHistory,
> {
  private mode: 'stopped' | 'starting' | 'running' | 'reconnecting' | 'paused' = 'stopped';
  private reason: string | null = null;
  private position: number | null = null;
  private run?: Run<C, H>;
  private recovery?: Recovery;
  private pending?: Promise<void>;
  private starting = false;
  private changing = false;
  private stoppedEpoch = 0;
  private readonly listeners = new Set<() => void>();
  private protection: StoredProtection | null = null;

  constructor(
    private readonly broker: Broker,
    private readonly store: TradingStore<HistoryEntry>,
    private readonly market: TradingFeed<C, H>,
    private readonly loadConfig: () => Promise<C>,
    private readonly now: () => number,
    private readonly findSignal: FindSignal<C, H>,
    private readonly loadRecoveryAccount: (order: OrderIntent) => Promise<RecoveryAccount> = () =>
      this.loadConfig(),
    private readonly validateTradingConfig: (config: C) => void = () => {},
    private readonly verifyFreshStart: () => Promise<void> = async () => {},
    private readonly loadCloseConfig: () => Promise<TradingConfig> = () => this.loadConfig(),
    private readonly improved?: ImprovedLive,
  ) {}

  public status() {
    const recovery = this.recovery;
    return {
      mode: this.mode,
      reason: this.reason,
      position: this.position,
      ...(this.improved && { protection: this.protection }),
      ...(recovery && {
        recovery: { orderId: recovery.order.id, ready: recovery.verifiedPosition !== null },
      }),
    };
  }

  public history(accountId?: string) {
    return this.store.history(accountId);
  }

  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async changeSettings(action: () => Promise<void>) {
    await this.withSettingsLock(async () => {
      await this.requireNoUnresolved();
      await action();
      this.position = null;
      this.reason = null;
    });
  }

  public async claimLegacySettings(action: () => Promise<void>) {
    if (
      (this.mode !== 'stopped' && this.mode !== 'paused') ||
      this.starting ||
      this.pending ||
      this.changing ||
      this.run
    )
      throw new RobotError('ROBOT_BUSY');
    this.changing = true;
    try {
      await action();
    } finally {
      this.changing = false;
    }
  }

  public async replaceCredentials(action: (accountId?: string) => Promise<void>) {
    await this.withSettingsLock(async () => {
      const order = this.recovery?.order ?? (await this.store.unresolved());
      const protection = this.improved && (await this.store.protection?.loadProtection());
      await action(order?.accountId ?? (protection ? protection.accountId : undefined));
      if (!order && !protection) {
        this.position = null;
        this.reason = null;
      }
    });
  }

  public async restore() {
    this.requireStopped();
    await this.runMaintenance(this.restoreStopped());
  }

  public async start() {
    this.requireStopped();
    await this.beginTradingRun(async () => {
      await this.requireNoUnresolved();
      await this.verifyFreshStart();
      const config = await this.loadConfig();
      this.validateTradingConfig(config);
      await this.broker.verifySelection(config);
      await this.readPosition(config, true);
      return { config, hasConfirmedEntry: false };
    });
  }

  public async resume() {
    // Recovery of an improved entry must also restore protection; not implemented in this slice.
    if (this.improved) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    const recovery = this.requireRecovery();
    const expected = recovery.verifiedPosition;
    if (expected === null) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    await this.beginTradingRun(async () => {
      const config = await this.recoveryConfig(recovery);
      this.validateTradingConfig(config);
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

  public stop() {
    this.stoppedEpoch++;
    if (!this.starting && !this.pending && this.recovery?.verifiedPosition != null)
      this.recovery = undefined;
    else if (this.mode === 'stopped') return;
    if (this.run) this.run.stopped = true;
    this.clearRun();
    this.mode = 'stopped';
    if (!this.recovery) this.reason = null;
    this.publish();
  }

  public async shutdown() {
    this.stop();
    await this.pending;
  }

  public async reconcile() {
    const recovery = this.requireRecovery();
    if (this.improved) {
      await this.runMaintenance(
        recovery.linkedClose
          ? this.reconcileLinkedClose(recovery.order.id).catch(async (error) => {
              await this.refreshCloseRecovery().catch(() => {});
              throw error;
            })
          : recovery.order.context.type === 'manual-close'
            ? this.reconcileOrder(recovery)
            : this.reconcileGuardedEntry(recovery),
      );
      return;
    }
    await this.runMaintenance(this.reconcileOrder(recovery));
  }

  public async reconcileProtection() {
    this.requireStopped();
    if (!this.improved) throw new RobotError('ROBOT_NO_PROTECTION');
    await this.runMaintenance(this.lookupProtection().then(() => {}));
  }

  public async closePosition(selection: Selection) {
    this.requireStopped();
    await this.runMaintenance(
      this.close(selection).catch((error) => {
        if (!this.recovery)
          this.reason = error instanceof RobotError ? error.code : 'ROBOT_CLOSE_FAILED';
        throw error;
      }),
    );
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }

  private requireStopped() {
    if (this.mode !== 'stopped' || this.starting || this.pending || this.changing)
      throw new RobotError('ROBOT_BUSY');
  }

  private async requireNoUnresolved() {
    if (this.improved) {
      if (!this.store.protection) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
      this.protection = await this.store.protection.loadProtection();
      if (await this.store.protection.loadProtectedEntry())
        throw new RobotError('ROBOT_ORDER_UNRESOLVED');
      // Even confirmed protection can compete with a manual exit or a new entry.
      if (this.protection) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    }
    if (this.recovery || (await this.store.hasUnresolved()))
      throw new RobotError('ROBOT_ORDER_UNRESOLVED');
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

  private async restoreStopped() {
    if (this.improved) {
      if (!this.store.protection) {
        this.reason = 'ROBOT_PROTECTION_UNRESOLVED';
        return;
      }
      this.protection = await this.store.protection.loadProtection();
      const entry = await this.store.protection.loadProtectedEntry();
      const order = entry?.order ?? (await this.store.unresolved());
      const previous = this.recovery;
      this.recovery = undefined;
      if (order) {
        this.recovery = {
          order,
          ...(order.protectionLink && { linkedClose: true }),
          state: previous?.order.id === order.id ? previous.state : order,
          rejectedBeforeAcceptance: false,
          verifiedPosition: null,
        };
      }
      this.position = null;
      this.reason = order
        ? 'ROBOT_ORDER_UNRESOLVED'
        : this.protection
          ? 'ROBOT_PROTECTION_UNRESOLVED'
          : null;
      return;
    }
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
    if (this.recovery) {
      const config = await this.loadRecoveryAccount(this.recovery.order).catch(() => null);
      if (!config) return;
      if (!sameSelection(config, this.recovery.order)) {
        this.reason = 'ROBOT_SELECTION_CHANGED';
        return;
      }
      await this.reconcileOrder(this.recovery, config);
    } else {
      const config = await this.loadConfig().catch(() => null);
      if (!config) return;
      this.reason = await this.readPosition(config, false).then(
        () => null,
        (error) => (error instanceof RobotError ? error.code : 'ROBOT_POSITION_UNVERIFIED'),
      );
      if (this.protection && !this.reason) this.reason = 'ROBOT_PROTECTION_UNRESOLVED';
    }
  }

  private async lookupProtection(configOverride?: TradingConfig) {
    const store = this.store.protection;
    if (!store || !this.improved) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    const protection = await store.loadProtection();
    this.protection = protection;
    if (!protection) throw new RobotError('ROBOT_NO_PROTECTION');
    if (!configOverride) this.reason = 'ROBOT_PROTECTION_UNRESOLVED';
    const config = configOverride ?? (await this.loadConfig());
    if (!sameSelection(config, protection)) throw new RobotError('ROBOT_SELECTION_CHANGED');
    let attempt;
    try {
      attempt = await store.beginEvidence(
        {
          accountId: protection.accountId,
          instrumentUid: protection.instrumentUid,
          stopId: protection.id,
          version: protection.version,
        },
        'lookup',
        randomUUID(),
      );
    } catch (error) {
      // The write may have committed despite a lost acknowledgement. Refresh
      // status only: neither a reload nor a pending marker grants ownership.
      await store.loadProtection().then(
        (current) => {
          this.protection = current;
        },
        () => {},
      );
      throw error;
    }
    if (!attempt.ok) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    this.protection = {
      ...protection,
      version: attempt.value.version,
      pendingAttempt: attempt.value,
      completedAttempt: null,
    };
    this.publish();
    const observation = await this.improved.protection
      .lookup(config, protection)
      .catch(() => (configOverride ? ({ status: 'unknown' } as const) : null));
    if (!observation) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    const result = await store.finishEvidence({ ...attempt.value, observation });
    if (!result.ok) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    this.protection = result.value;
    return { protection: result.value, observation };
  }

  private async beginTradingRun(
    prepare: () => Promise<{ config: C; hasConfirmedEntry: boolean }>,
    recovery?: Recovery,
  ) {
    const previousMode = this.mode;
    let run: Run<C, H> | undefined;
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
      const next: Run<C, H> = { config, lastAttemptedCandleOpenMs: -Infinity, hasConfirmedEntry };
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

  private clearRun() {
    this.run?.unsubscribe?.();
    this.run = undefined;
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

  private async reconcileOrder(recovery: Recovery, restoredConfig?: RecoveryAccount) {
    recovery.verifiedPosition = null;
    this.position = null;
    this.reason = 'ROBOT_ORDER_UNRESOLVED';
    const config = restoredConfig ?? (await this.loadRecoveryAccount(recovery.order));
    if (!sameSelection(config, recovery.order)) throw new RobotError('ROBOT_SELECTION_CHANGED');
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

  private async runMaintenance(operation: Promise<void>) {
    this.pending = operation.finally(() => {
      this.pending = undefined;
      this.publish();
    });
    await this.pending;
  }

  private async close(selection: Selection) {
    const epoch = this.stoppedEpoch;
    if (this.improved && !this.store.protection)
      throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    if (this.recovery || (await this.store.hasUnresolved()))
      throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    const config = await this.loadCloseConfig();
    const { accountId, instrumentUid, ticker, timeframe } = config;
    if (!sameSelection(config, selection)) {
      throw new RobotError('ROBOT_SELECTION_CHANGED');
    }
    if (this.improved) {
      const protection = await this.store.protection!.loadProtection();
      this.protection = protection;
      if (protection) {
        if (!sameSelection(config, protection)) throw new RobotError('ROBOT_SELECTION_CHANGED');
        try {
          await this.closeProtected(config, protection, epoch);
        } catch (error) {
          await this.refreshCloseRecovery().catch(() => {});
          throw error;
        }
        return;
      }
    }
    const fromPosition = await this.readPosition(config, false);
    this.reason = null;
    const delta = journalPositionDelta(fromPosition, 0);
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
      context: { type: 'manual-close', time: this.now() },
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

  private async proveStopInactive(
    config: TradingConfig,
    protection: StoredProtection,
    canCancel: () => boolean,
    cancel: boolean,
    verifyUnchanged = false,
  ) {
    const store = this.store.protection!;
    const port = this.improved!.protection;
    const blocked = () => new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    if (!port.closeEvidence) throw blocked();
    if (
      protection.evidenceConflict ||
      protection.pendingAttempt ||
      !Number.isSafeInteger(protection.lots) ||
      protection.lots <= 0
    )
      throw blocked();
    const ref = () => ({
      accountId: protection.accountId,
      instrumentUid: protection.instrumentUid,
      stopId: protection.id,
      version: protection.version,
    });
    // Validate the account and absence of competing orders before any mutation.
    const before = await this.readPosition(config, false);
    if (!Number.isSafeInteger(before)) throw new RobotError('ROBOT_POSITION_UNVERIFIED');
    if (
      verifyUnchanged &&
      cancel &&
      before !== (protection.direction === 'sell' ? 1 : -1) * protection.lots
    )
      throw new RobotError('ROBOT_POSITION_CHANGED');
    if (!canCancel()) throw blocked();
    if (
      cancel &&
      !protection.cancellationPending &&
      (protection.state === 'confirmed' || protection.state === 'unconfirmed')
    ) {
      if (!port.cancel) throw blocked();
      const cancellation = await store.beginCancellation(ref());
      if (!cancellation.ok) throw blocked();
      protection = this.protection = cancellation.value;
      if (!canCancel()) throw blocked();
      // Acknowledgement, failure and timeout all require independent evidence.
      try {
        await port.cancel(config, protection);
      } catch {
        // An unacknowledged cancellation is never retried.
      }
    }
    const begun = await store.beginEvidence(ref(), 'close', randomUUID());
    if (!begun.ok) throw blocked();
    this.protection = {
      ...protection,
      version: begun.value.version,
      pendingAttempt: begun.value,
      completedAttempt: null,
    };
    this.publish();
    const parent = await port.closeEvidence(config, protection).catch(() => {
      throw blocked();
    });
    const ids = parent.status === 'triggered' ? [...new Set(parent.childIds.filter(Boolean))] : [];
    const children = [];
    if (ids.length) {
      if (!port.childEvidence) throw blocked();
      for (const id of ids) {
        try {
          children.push({ ...(await port.childEvidence(config, protection, id)), childId: id });
        } catch {
          throw blocked();
        }
      }
    }
    const stopObservation =
      parent.status === 'never-triggered' &&
      protection.state !== 'not-sent' &&
      protection.state !== 'rejected'
        ? await port.lookup(config, protection).catch(() => {
            throw blocked();
          })
        : undefined;
    const finished = await store.finishEvidence({
      ...begun.value,
      parent,
      children,
      stopObservation,
    });
    if (!finished.ok) throw blocked();
    const { closeProof, ...current } = finished.value;
    this.protection = current;
    if (!closeProof) throw blocked();
    const executed = children.reduce((sum, child) => sum + (child.executedLots ?? NaN), 0);
    if (!Number.isSafeInteger(executed) || executed > protection.lots) throw blocked();
    const expected = (protection.direction === 'sell' ? 1 : -1) * (protection.lots - executed);
    const fromPosition = await this.readPosition(config, false);
    if (fromPosition !== expected) throw new RobotError('ROBOT_POSITION_CHANGED');
    const account = {
      accountId: config.accountId,
      instrumentUid: config.instrumentUid,
      position: fromPosition,
      activeOrders: false,
    };
    return { closeProof, account, fromPosition, executed, current };
  }

  private async closeProtected(
    config: TradingConfig,
    protection: StoredProtection,
    epoch: number,
    automatic?: { context: OrderContext; canDispatch: () => boolean; cancel: boolean },
  ) {
    const canDispatch = () =>
      epoch === this.stoppedEpoch && (!automatic || automatic.canDispatch());
    const evidence = await this.proveStopInactive(
      config,
      protection,
      canDispatch,
      automatic?.cancel ?? true,
      !!automatic,
    );
    return this.closeAfterProof(config, evidence, canDispatch, automatic?.context);
  }

  private async closeAfterProof(
    config: TradingConfig,
    {
      closeProof,
      account,
      fromPosition,
      executed,
    }: Awaited<ReturnType<Robot<C, HistoryEntry, H>['proveStopInactive']>>,
    canDispatch: () => boolean,
    context?: OrderContext,
    canSend = canDispatch,
  ) {
    const store = this.store.protection!;
    const blocked = () => new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    if (!canDispatch()) throw blocked();
    if (fromPosition === 0) {
      if (!(await store.clearChildFlat(closeProof, account)).ok) throw blocked();
      this.protection = null;
      this.reason = null;
      return { kind: 'native' } as const;
    }
    const delta = journalPositionDelta(fromPosition, 0)!;
    const intent: OrderIntent = {
      id: randomUUID(),
      accountId: config.accountId,
      instrumentUid: config.instrumentUid,
      ticker: config.ticker,
      timeframe: config.timeframe,
      fromPosition,
      targetPosition: 0,
      ...delta,
      context: context ?? { type: 'manual-close', time: this.now() },
    };
    const reserved = await store.reserveProtectedClose(closeProof, intent, account);
    if (!reserved.ok) throw blocked();
    const { reservationOwner } = reserved.value;
    if (!canSend()) {
      const cancelled = await store.cancelProtectedCloseBeforeSend(
        reservationOwner,
        'stopped-before-send',
      );
      if (context && cancelled.ok) return { kind: 'not-sent' } as const;
      throw blocked();
    }
    const claim = await store.beginProtectedCloseSubmit(reservationOwner);
    if (!claim.ok) throw blocked();
    const { order, submitOwner } = claim.value;
    this.setCloseRecovery(order);
    this.publish();
    let check = await this.recheckPosition(config, fromPosition);
    let currentConfig: TradingConfig | null = context ? config : null;
    try {
      if (!context) currentConfig = await this.loadCloseConfig();
    } catch {
      // Missing credentials cannot authorize dispatch.
    }
    if (
      !currentConfig ||
      !sameSelection(config, currentConfig) ||
      currentConfig.token !== config.token
    )
      check = 'ROBOT_SELECTION_CHANGED';
    if (check || !canSend()) {
      const cancelled = await store.cancelProtectedCloseBeforeSend(
        submitOwner,
        check ? 'account-check-failed-before-send' : 'stopped-before-send',
      );
      if (context && !check && cancelled.ok) {
        await this.refreshCloseRecovery();
        return { kind: 'not-sent' } as const;
      }
      throw new RobotError(check ?? 'ROBOT_PROTECTION_UNRESOLVED');
    }
    let posted: BrokerOrder | null = null;
    if (!store.consumeProtectedCloseSubmit(submitOwner)) throw blocked();
    try {
      posted = { ...(await this.broker.submit(config.token, intent)), executions: [] };
    } catch {
      // Both synchronous and asynchronous submission failures are ambiguous.
    }
    if (posted) this.setCloseRecovery(order, posted);
    if (!(await this.observeLinkedClose(config, order, posted, false))) {
      if (!context) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
      return { kind: 'pending', id: order.id, native: executed !== 0 } as const;
    }
    return { kind: executed === 0 ? 'market' : 'native' } as const;
  }

  private setCloseRecovery(order: LinkedOrder, state: BrokerOrder = order) {
    this.recovery = {
      order,
      state,
      linkedClose: true,
      rejectedBeforeAcceptance: false,
      verifiedPosition: null,
    };
    this.reason = 'ROBOT_ORDER_UNRESOLVED';
  }

  private async refreshCloseRecovery() {
    this.protection = await this.store.protection!.loadProtection();
    const order = await this.store.unresolved();
    if (!order) {
      if (this.recovery?.linkedClose)
        this.reason = this.protection ? 'ROBOT_PROTECTION_UNRESOLVED' : null;
      this.recovery = undefined;
    } else if (order.protectionLink && this.recovery?.order.id !== order.id) {
      const linked = await this.store.protection!.loadProtectedClose(order.id);
      if (linked) this.setCloseRecovery(linked);
    }
  }

  private async reconcileLinkedClose(id: string) {
    this.position = null;
    const store = this.store.protection!;
    const order = await store.loadProtectedClose(id);
    if (!order || (await this.store.unresolved())?.id !== id) {
      await this.refreshCloseRecovery();
      return;
    }
    if (order.submitState !== 'claimed') throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    const config = await this.loadRecoveryAccount(order);
    if (!sameSelection(config, order)) throw new RobotError('ROBOT_SELECTION_CHANGED');
    await this.observeLinkedClose(config, order, null, true);
  }

  private async observeLinkedClose(
    config: RecoveryAccount,
    order: LinkedOrder,
    posted: BrokerOrder | null,
    reconciling: boolean,
  ) {
    const { state, account } = await this.readOrderAndAccount(config, order, null);
    const previous = this.recovery?.order.id === order.id ? this.recovery.state : order;
    const minimum = Math.max(
      order.executedLots ?? 0,
      previous.executedLots ?? 0,
      posted?.executedLots ?? 0,
      ...[order, previous, ...(posted ? [posted] : [])].map((evidence) =>
        evidence.executions.reduce((sum, fill) => sum + fill.lots, 0),
      ),
    );
    // An absent/incomplete lookup cannot retire a claimed close or fence a live owner.
    if (reconciling && (!state?.brokerOrderId || state.brokerStatus === 'unknown')) return false;
    // A crash before the first acknowledged observation can have lost a
    // positive submit response. A zero fill cannot retire that orphan.
    if (reconciling && order.status === 'reserved' && state?.executedLots === 0 && minimum === 0)
      return false;
    const verified =
      state &&
      state.brokerOrderId &&
      [order, previous, posted].every(
        (evidence) => !evidence?.brokerOrderId || evidence.brokerOrderId === state.brokerOrderId,
      ) &&
      state.executedLots !== null &&
      state.executedLots >= minimum &&
      new Set(state.executions.map((execution) => execution.tradeId)).size ===
        state.executions.length &&
      [order, previous].every((evidence) =>
        evidence.executions.every((prior) =>
          state.executions.some(
            (execution) =>
              execution.tradeId === prior.tradeId &&
              execution.lots === prior.lots &&
              execution.price === prior.price &&
              execution.time === prior.time,
          ),
        ),
      ) &&
      !orderProblem(order, state, account);
    const full = verified && state.brokerStatus === 'filled';
    const zero =
      verified &&
      state.executedLots === 0 &&
      (state.brokerStatus === 'rejected' || state.brokerStatus === 'cancelled');
    const accepted = reconciling || posted?.brokerStatus === 'filled';
    const settled = accepted && (full || (reconciling && zero));
    const evidence = state ?? posted ?? previous;
    const contradictory =
      minimum > (evidence.executedLots ?? 0) ||
      [order, previous, posted].some(
        (prior) =>
          prior?.brokerOrderId &&
          evidence.brokerOrderId &&
          prior.brokerOrderId !== evidence.brokerOrderId,
      );
    const details = {
      ...(contradictory ? previous : evidence),
      executedLots: contradictory ? minimum : evidence.executedLots,
    };
    this.position = account?.position ?? null;
    this.setCloseRecovery(order, details);
    const result = await this.store.protection!.settleProtectedClose(
      order.protectionLink,
      order.orderVersion,
      {
        kind: 'observed',
        result: {
          ...details,
          status: settled ? (reconciling ? 'reconciled' : 'confirmed') : 'unconfirmed',
          position: this.position,
        },
        ...(account && {
          account: { ...account, accountId: config.accountId, instrumentUid: config.instrumentUid },
        }),
      },
    );
    if (!result.ok) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    const released =
      settled && (result.value.status === 'confirmed' || result.value.status === 'reconciled');
    if (released) {
      await this.refreshCloseRecovery();
      this.reason = this.recovery
        ? 'ROBOT_ORDER_UNRESOLVED'
        : this.protection
          ? 'ROBOT_PROTECTION_UNRESOLVED'
          : null;
    }
    return released;
  }

  private pause(run: Run<C, H>, reason: string) {
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

  private onMarket(
    run: Run<C, H>,
    { stream, history, recoveredAt, freshCandleTime, openedCandleTime }: FeedUpdate<H>,
  ) {
    if (this.run !== run) return;
    if (stream === 'unconfigured') return this.pause(run, 'ROBOT_FEED_LOST');
    if (stream === 'disconnected' || (stream === 'connecting' && run.session)) {
      run.session = undefined;
      run.reconnect = undefined;
      run.deferredClose = undefined;
      run.reconnectGeneration = (run.reconnectGeneration ?? 0) + 1;
      this.mode = 'reconnecting';
      this.reason = 'ROBOT_FEED_LOST';
      this.publish();
      return;
    }
    if (stream !== 'live') return;
    if (
      history &&
      (history.instrumentUid !== run.config.instrumentUid ||
        history.timeframe !== run.config.timeframe)
    )
      return;
    // Reject premature completed data and its marker, but retain incomplete evidence.
    if (
      this.improved &&
      history &&
      freshCandleTime !== undefined &&
      freshCandleTime + timeframeMs[history.timeframe] > this.now()
    ) {
      const market = history as unknown as MarketHistory;
      if (Array.isArray(market.candles))
        history = {
          ...market,
          candles: market.candles.filter(
            (candle) => candle.time !== freshCandleTime || !candle.complete,
          ),
        } as unknown as H;
      freshCandleTime = undefined;
    }
    const reconnecting = this.mode === 'reconnecting';
    if (reconnecting && this.improved) {
      if (!this.improved.protection.closeEvidence) return;
      if (history && (recoveredAt !== undefined || run.reconnect)) {
        const cutoff = recoveredAt ?? run.reconnect!.cutoff;
        if (Number.isFinite(cutoff) && cutoff <= this.now())
          run.reconnect = { history, cutoff, generation: run.reconnectGeneration ?? 0 };
      }
      this.tryImprovedReconnect(run);
      return;
    }
    const since = reconnecting ? recoveredAt : (run.session?.since ?? this.now());
    if (since === undefined || (reconnecting && !history)) return;
    const session = (run.session ??= { since });
    if (!history) return;
    if (this.improved) {
      if (!this.rememberImprovedCandles(session, history))
        return this.pause(run, 'ROBOT_FEED_LOST');
      const candles = (history as unknown as MarketHistory).candles;
      if (Array.isArray(candles)) {
        for (const candle of candles) {
          if (candle.complete && Number.isFinite(candle.time))
            session.latestCompleted = Math.max(session.latestCompleted ?? -Infinity, candle.time);
        }
      }
    }
    const initialSnapshot = !session.snapshotSeen;
    session.snapshotSeen = true;
    if (this.mode === 'starting' || this.mode === 'reconnecting') {
      this.mode = 'running';
      this.reason = null;
      this.publish();
    }
    if (this.improved && run.deferredClose && !initialSnapshot) {
      session.checkDeferredClose = true;
      this.drainMarket(run, session, history);
      return;
    }
    if (this.recovery) return;
    if (this.improved) {
      if (
        session.queuedFresh !== undefined &&
        (session.indicators?.invalid ||
          (session.latestCompleted ?? -Infinity) > session.queuedFresh)
      )
        session.queuedFresh = undefined;
      if (initialSnapshot) return;
      if (openedCandleTime !== undefined && this.protection) {
        const open = (history as unknown as MarketHistory).candles?.find(
          (candle) => candle.time === openedCandleTime && !candle.complete,
        );
        const now = this.now();
        if (
          open &&
          Number.isFinite(open.open) &&
          open.time >= session.since &&
          open.time > (run.lastOpened ?? -Infinity) &&
          open.time <= now &&
          now < open.time + timeframeMs[run.config.timeframe]
        ) {
          run.lastOpened = open.time;
          session.queuedOpen = open;
        }
      }
      if (freshCandleTime === undefined) {
        this.drainMarket(run, session, history);
        return;
      }
      if (
        !Number.isFinite(freshCandleTime) ||
        !session.indicators?.candles.has(freshCandleTime) ||
        freshCandleTime + timeframeMs[history.timeframe] > this.now() ||
        freshCandleTime < (session.latestCompleted ?? -Infinity)
      )
        return this.drainMarket(run, session, history);
      session.queuedFresh = freshCandleTime;
      this.drainMarket(run, session, history);
      return;
    }
    if (this.pending) {
      session.queued = history;
      return;
    }
    session.queued = undefined;
    this.evaluateMarket(run, session, history);
  }

  private evaluateMarket(run: Run<C, H>, session: LiveSession<H>, history: H) {
    const crossing = this.findSignal(
      history,
      {
        since: session.since,
        now: this.now(),
        lastAttempted: run.lastAttemptedCandleOpenMs,
      },
      run.config,
    );
    if (!crossing) return;
    run.lastAttemptedCandleOpenMs = crossing.candleTime;
    this.runMarketOperation(run, session, history, this.trade(run, session, crossing, 0));
  }

  private runMarketOperation(
    run: Run<C, H>,
    session: LiveSession<H>,
    history: H,
    operation: Promise<void>,
  ) {
    this.pending = operation
      .catch((error) => {
        if (this.run === run && run.session === session)
          this.pause(run, error instanceof RobotError ? error.code : 'ROBOT_TRADE_FAILED');
      })
      .finally(() => {
        this.pending = undefined;
        const queued = run.session?.queued;
        if (queued && this.run === run) this.onMarket(run, { stream: 'live', history: queued });
        if (this.run === run && run.session === session) this.drainMarket(run, session, history);
        if (this.run === run && !run.session) this.tryImprovedReconnect(run);
      });
  }

  private drainMarket(run: Run<C, H>, session: LiveSession<H>, history: H) {
    if (!this.improved || this.pending || this.run !== run || run.session !== session) return;
    if (run.deferredClose) {
      if (session.checkDeferredClose || session.queuedFresh !== undefined || session.queuedOpen) {
        session.checkDeferredClose = false;
        session.queuedFresh = undefined;
        session.queuedOpen = undefined;
        this.runMarketOperation(run, session, history, this.checkDeferredClose(run, session));
      }
      return;
    }
    const opened = session.queuedOpen;
    session.queuedOpen = undefined;
    if (opened && this.protection && this.now() < opened.time + timeframeMs[run.config.timeframe]) {
      this.runMarketOperation(
        run,
        session,
        history,
        this.tradeImprovedOpening(run, session, opened),
      );
      return;
    }
    const fresh = session.queuedFresh;
    session.queuedFresh = undefined;
    if (
      fresh === undefined ||
      fresh <= run.lastAttemptedCandleOpenMs ||
      fresh < (session.latestCompleted ?? -Infinity)
    )
      return;
    const crossing = this.findImprovedSignal(
      history,
      session,
      fresh,
      session.since,
      run.lastAttemptedCandleOpenMs,
    );
    const revision = session.revision ?? 0;
    if (crossing || this.protection) {
      run.lastAttemptedCandleOpenMs = fresh;
      this.runMarketOperation(
        run,
        session,
        history,
        this.tradeImprovedClose(run, session, fresh, crossing, revision),
      );
    }
  }

  private async tradeImprovedOpening(
    run: Run<C, H>,
    session: LiveSession<H>,
    opened: MarketHistory['candles'][number],
  ) {
    const previous = [...(session.indicators?.candles.values() ?? [])]
      .filter((candle) => candle.time < opened.time)
      .sort((a, b) => b.time - a.time)[0];
    const side = this.protection?.direction === 'sell' ? 1 : -1;
    const live = () => this.run === run && run.session === session;
    const protection = await this.checkLiveProtection(run, live, opened.time);
    if (
      !protection ||
      !previous ||
      previous.confirmedEma === null ||
      session.indicators?.invalid ||
      [...(session.indicators?.incomplete ?? [])].some(
        (time) => time > previous.time && time < opened.time,
      ) ||
      !live()
    )
      return;
    if (side * (opened.open - protection.stop) <= 0) {
      run.blockedThrough = opened.time;
      return;
    }
    if (!gapAgainstPosition(side, opened.open, previous.confirmedEma)) return;
    const signalTime = opened.time;
    await this.closeLiveProtection(run, protection, live, {
      type: 'signal',
      candleTime: opened.time,
      signalTime,
      strategy: {
        kind: 'improved-surfing',
        reason: 'gap',
        open: opened.open,
        ema: previous.confirmedEma,
      },
    });
    run.blockedThrough = opened.time;
  }

  private async tradeImprovedClose(
    run: Run<C, H>,
    session: LiveSession<H>,
    time: number,
    crossing: LiveSignal | undefined,
    revision: number,
  ) {
    const live = () => this.run === run && run.session === session;
    const current = () => live() && this.signalCurrent(run, session, time, revision, this.now());
    if (this.protection) {
      const protection = await this.checkLiveProtection(run, live, time);
      if (!protection || !current() || time <= (run.blockedThrough ?? -Infinity)) return;
      if (!crossing || crossing.targetPosition === (protection.direction === 'sell' ? 1 : -1)) {
        await this.adjustPosition(run, session, time, revision, protection, current);
        return;
      }
      const hours = await this.improved!.session(run.config, crossing.signalTime);
      if (!current() || !this.eligibleSession(hours, crossing.signalTime)) return;
      const dispatch = () => current() && this.eligibleSession(hours, crossing.signalTime);
      const evidence = await this.proveStopInactive(run.config, protection, dispatch, true, true);
      const native = evidence.current.closeObservation?.status === 'triggered';
      if (!native && !dispatch()) {
        await this.replaceLiveStop(run, evidence, protection.stop);
        return;
      }
      const outcome = await this.closeAfterProof(
        run.config,
        evidence,
        live,
        {
          type: 'signal',
          candleTime: time,
          signalTime: crossing.signalTime,
          strategy: {
            ...crossing.strategy,
            reason: native ? 'protection-recovery' : 'reversal-exit',
          },
        },
        native ? live : dispatch,
      );
      if (outcome.kind === 'not-sent' && !native) {
        const refreshed = await this.proveStopInactive(
          run.config,
          this.protection!,
          () => true,
          false,
        );
        if (refreshed.current.closeObservation?.status === 'never-triggered')
          await this.replaceLiveStop(run, refreshed, protection.stop);
        return;
      }
      run.improvedPosition = undefined;
      if (outcome.kind === 'pending' && live()) {
        run.deferredClose = {
          id: outcome.id,
          ...(!native && { reverse: { signal: crossing, revision, hours: hours! } }),
        };
      }
      this.publish();
      if (outcome.kind !== 'market' || !dispatch()) return;
    }
    if (crossing && time > (run.blockedThrough ?? -Infinity))
      await this.trade(run, session, crossing, revision);
  }

  private async closeLiveProtection(
    run: Run<C, H>,
    protection: StoredProtection,
    live: () => boolean,
    context: OrderContext,
    cancel = true,
  ) {
    try {
      const outcome = await this.closeProtected(run.config, protection, this.stoppedEpoch, {
        context,
        canDispatch: live,
        cancel,
      });
      if (outcome.kind === 'pending' && live()) run.deferredClose = { id: outcome.id };
      run.improvedPosition = undefined;
      return outcome;
    } catch (error) {
      await this.refreshCloseRecovery().catch(() => {});
      throw error;
    } finally {
      this.publish();
    }
  }

  private async checkDeferredClose(run: Run<C, H>, session: LiveSession<H>) {
    const deferred = run.deferredClose!;
    const live = () =>
      this.run === run && run.session === session && run.deferredClose === deferred;
    const eligible = (reverse: NonNullable<typeof deferred.reverse>) => {
      const now = this.now();
      return (
        this.signalCurrent(run, session, reverse.signal.candleTime, reverse.revision, now) &&
        this.eligibleSession(reverse.hours, reverse.signal.signalTime, now)
      );
    };
    if (deferred.reverse && !eligible(deferred.reverse)) deferred.reverse = undefined;
    await this.reconcileLinkedClose(deferred.id);
    if (!live()) return;
    this.publish();
    if (this.recovery) return;
    run.deferredClose = undefined;
    if (this.protection || this.position !== 0) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    run.improvedPosition = undefined;
    if (deferred.reverse && eligible(deferred.reverse))
      await this.trade(run, session, deferred.reverse.signal, deferred.reverse.revision);
  }

  private async checkLiveProtection(run: Run<C, H>, live: () => boolean, time: number) {
    const { protection, observation } = await this.lookupProtection(run.config);
    if (!live()) return;
    if (protection.pendingAttempt || protection.evidenceConflict)
      throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    if (
      observation.status === 'active' &&
      !protection.cancellationPending &&
      (protection.state === 'confirmed' || protection.state === 'unconfirmed') &&
      protection.observation?.status === 'active' &&
      !protection.childIds?.length
    ) {
      const error = await this.recheckPosition(
        run.config,
        (protection.direction === 'sell' ? 1 : -1) * protection.lots,
      );
      if (error) throw new RobotError(error);
      return live() ? protection : undefined;
    }
    if (
      (observation.status === 'unknown' &&
        protection.state !== 'not-sent' &&
        protection.state !== 'rejected') ||
      (observation.status === 'triggered' && observation.childStatus !== 'terminal')
    )
      return;
    run.blockedThrough = Math.max(run.blockedThrough ?? -Infinity, time);
    await this.closeLiveProtection(
      run,
      protection,
      live,
      {
        type: 'signal',
        candleTime: time,
        signalTime: this.now(),
        strategy: { kind: 'improved-surfing', reason: 'protection-recovery' },
      },
      false,
    );
    run.improvedPosition = undefined;
  }

  private async adjustPosition(
    run: Run<C, H>,
    session: LiveSession<H>,
    time: number,
    revision: number,
    protection: StoredProtection,
    current: () => boolean,
  ) {
    const improved = this.improved!;
    const model = run.improvedPosition;
    const completed = this.improvedCompletion(session, time);
    if (!model || !completed || !improved.protection.cancel) return;
    const position = { ...model, stop: protection.stop };
    const { candle, atr } = completed;
    const trailed =
      atr === null ? position : trailStop(position, candle.close, atr, improved.parameters);
    const stop = Number.isFinite(trailed.stop) && trailed.stop > 0 ? trailed.stop : protection.stop;
    const context: OrderContext = {
      type: 'signal',
      candleTime: time,
      signalTime: time + timeframeMs[run.config.timeframe],
      strategy: {
        kind: 'improved-surfing',
        reason: 'add-on',
        close: candle.close,
        atr,
        ema: candle.confirmedEma,
      },
    };
    const target = position.side * (protection.lots + position.entryLots);
    let add: OrderIntent | undefined;
    if (
      improved.protection.canIncrease &&
      Math.abs(target) <= 2_147_483_647 &&
      addOnDue(position, candle.close, improved.parameters)
    ) {
      const hours = await improved.session(run.config, context.signalTime);
      if (current() && this.eligibleSession(hours, context.signalTime)) {
        const { accountId, instrumentUid, ticker, timeframe } = run.config;
        const intent: OrderIntent = {
          id: randomUUID(),
          accountId,
          instrumentUid,
          ticker,
          timeframe,
          context,
          fromPosition: position.side * protection.lots,
          targetPosition: target,
          direction: position.side === 1 ? 'buy' : 'sell',
          lots: position.entryLots,
        };
        if (await improved.protection.canIncrease(run.config, intent)) add = intent;
      }
    }
    if (!current()) return;
    if (!add && stop === protection.stop) {
      run.improvedPosition = { ...trailed, stop };
      return;
    }
    const epoch = this.stoppedEpoch;
    const live = () => this.stoppedEpoch === epoch && this.run === run && run.session === session;
    const evidence = await this.proveStopInactive(
      run.config,
      protection,
      () => live() && current(),
      true,
      true,
    );
    if (evidence.current.closeObservation?.status !== 'never-triggered') {
      run.blockedThrough = time;
      const outcome = await this.closeAfterProof(run.config, evidence, live, {
        ...context,
        strategy: { kind: 'improved-surfing', reason: 'protection-recovery' },
      });
      if (outcome.kind === 'pending' && live()) run.deferredClose = { id: outcome.id };
      this.publish();
      run.improvedPosition = undefined;
      return;
    }
    const plan = { id: randomUUID(), stop: current() ? stop : protection.stop };
    if (add && current()) {
      const signal: LiveSignal = {
        candleTime: time,
        signalTime: context.signalTime,
        targetPosition: position.side,
        strategy: context.strategy,
      };
      await this.tradeGuarded(run, session, signal, add, revision, {
        proof: evidence.closeProof,
        plan,
        fallback: { id: randomUUID(), stop: protection.stop },
        nextPosition: { ...trailed, stop: plan.stop, addOns: position.addOns + 1 },
      });
      return;
    }
    await this.replaceLiveStop(run, evidence, plan.stop);
    if (current()) run.improvedPosition = { ...trailed, stop: plan.stop };
  }

  private async replaceLiveStop(
    run: Run<C, H>,
    evidence: Awaited<ReturnType<Robot<C, HistoryEntry, H>['proveStopInactive']>>,
    stop: number,
  ) {
    const replaced = await this.store.protection!.replaceProtection(
      evidence.closeProof,
      { id: randomUUID(), stop },
      evidence.account,
    );
    if (!replaced.ok) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    this.protection = replaced.value;
    if (await this.recheckPosition(run.config, evidence.fromPosition))
      throw new RobotError('ROBOT_POSITION_CHANGED');
    await this.submitInitialStop(run, replaced.value, true);
    this.finishLiveStop(run);
  }

  private tryImprovedReconnect(run: Run<C, H>) {
    if (!this.improved || this.pending || !run.reconnect) return;
    const snapshot = run.reconnect;
    const live = () =>
      this.run === run &&
      this.mode === 'reconnecting' &&
      run.reconnect?.generation === snapshot.generation;
    const operation = async () => {
      if (this.recovery?.linkedClose) await this.reconcileLinkedClose(this.recovery.order.id);
      if (this.recovery || (await this.store.hasUnresolved()))
        throw new RobotError('ROBOT_ORDER_UNRESOLVED');
      this.protection = await this.store.protection!.loadProtection();
      if (!live()) return;
      if (this.protection) {
        const checked = await this.checkLiveProtection(run, live, snapshot.cutoff);
        if (this.protection && !checked) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
      } else await this.readPosition(run.config, true);
      if (!live()) return;
      const { history, cutoff } = run.reconnect!;
      run.reconnect = undefined;
      this.mode = 'starting';
      // A delayed reconciliation may finish after more snapshots have arrived.
      // Treat all of them as baseline; none are authority to replay a signal.
      run.session = { since: Math.max(cutoff, this.now()) };
      this.onMarket(run, { stream: 'live', history });
    };
    this.pending = operation()
      .catch((error) => {
        if (live())
          this.pause(run, error instanceof RobotError ? error.code : 'ROBOT_TRADE_FAILED');
      })
      .finally(() => {
        this.pending = undefined;
        if (!run.session && this.run === run) this.tryImprovedReconnect(run);
      });
  }

  private signalCurrent(
    run: Run<C, H>,
    session: LiveSession<H>,
    time: number,
    revision: number,
    now: number,
  ) {
    return (
      (session.revision ?? 0) === revision &&
      !session.indicators?.invalid &&
      (session.latestCompleted ?? -Infinity) <= time &&
      time + 2 * timeframeMs[run.config.timeframe] > now
    );
  }

  private async trade(
    run: Run<C, H>,
    session: LiveSession<H>,
    signal: LiveSignal,
    revision: number,
  ) {
    const stillLive = () => this.run === run && run.session === session;
    const stale = (now = this.now()) =>
      !!this.improved &&
      ((session.revision ?? 0) !== revision ||
        session.indicators?.invalid ||
        (session.latestCompleted ?? -Infinity) > signal.candleTime ||
        signal.candleTime + 2 * timeframeMs[run.config.timeframe] <= now);
    const fromPosition = await this.readPosition(run.config, !run.hasConfirmedEntry).catch(
      (error) => {
        if (stillLive()) throw error;
        return null;
      },
    );
    if (fromPosition === null || !stillLive()) return;
    let targetPosition = signal.targetPosition;
    if (this.improved) {
      if (fromPosition !== 0 || this.protection) return;
      const eligible = await this.improved.session(run.config, signal.signalTime).catch((error) => {
        if (stillLive()) throw error;
        return null;
      });
      if (!stillLive() || !this.eligibleSession(eligible, signal.signalTime)) return;
      const sizing = await this.improved.protection.sizing(run.config).catch((error) => {
        if (stillLive()) throw error;
        return null;
      });
      if (!sizing) return;
      if (!stillLive()) return;
      const lots = entryLots(sizing.freeMoney, Number(signal.strategy.close), sizing.pointValue);
      if (!lots || lots > 2_147_483_647) return;
      targetPosition = signal.targetPosition * lots;
    }
    const delta = journalPositionDelta(fromPosition, targetPosition);
    if (!delta) {
      this.publish();
      return;
    }
    const { accountId, instrumentUid, ticker, timeframe } = run.config;
    const intent: OrderIntent = {
      targetPosition,
      context: {
        type: 'signal',
        candleTime: signal.candleTime,
        signalTime: signal.signalTime,
        strategy: signal.strategy,
      },
      id: randomUUID(),
      accountId,
      instrumentUid,
      ticker,
      timeframe,
      fromPosition,
      ...delta,
    };
    if (stale()) return;
    if (this.isImproved()) {
      await this.tradeGuarded(run, session, signal, intent, revision);
      return;
    }
    if (!(await this.store.reserve(intent))) {
      if (await this.store.hasUnresolved()) this.pause(run, 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.publish();
    let eligible: { start: number; end: number } | null = null;
    if (this.improved && stillLive()) {
      try {
        eligible = await this.improved.session(run.config, signal.signalTime);
      } catch (error) {
        const live = stillLive();
        await this.recordNotSent(
          intent,
          live
            ? 'session-check-failed-before-send'
            : run.stopped
              ? 'stopped-before-send'
              : 'feed-lost-before-send',
        );
        this.publish();
        if (live && stillLive()) throw error;
        return;
      }
    }
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
    const finalNow = this.improved ? this.now() : 0;
    if (this.improved && stale(finalNow)) {
      await this.recordNotSent(intent, 'stale-signal-before-send');
      this.publish();
      return;
    }
    if (this.improved && !this.eligibleSession(eligible, signal.signalTime, finalNow)) {
      await this.recordNotSent(intent, 'session-ended-before-send');
      this.publish();
      return;
    }
    if (await this.submitAndRecord(run.config, intent)) {
      run.hasConfirmedEntry = true;
    }
    this.publish();
  }

  private isImproved() {
    return !!this.improved;
  }

  private eligibleSession(
    session: { start: number; end: number } | null,
    signalTime: number,
    now = this.now(),
  ) {
    if (
      !session ||
      !Number.isFinite(session.start) ||
      !Number.isFinite(session.end) ||
      signalTime < session.start ||
      signalTime >= session.end ||
      now < signalTime ||
      now >= session.end
    )
      return false;
    if (!this.improved!.parameters.tradeWeekends) {
      const day = new Date(now + 3 * 60 * 60 * 1000).getUTCDay();
      if (day === 0 || day === 6) return false;
    }
    return true;
  }

  private findImprovedSignal(
    history: H,
    session: LiveSession<H>,
    freshTime: number,
    since: number,
    lastAttempted: number,
  ): LiveSignal | undefined {
    if (
      !this.improved ||
      !validImproved(this.improved.parameters) ||
      freshTime <= lastAttempted ||
      freshTime + timeframeMs[history.timeframe] <= since ||
      !Number.isFinite(freshTime) ||
      freshTime + timeframeMs[history.timeframe] > this.now() ||
      freshTime + 2 * timeframeMs[history.timeframe] <= this.now()
    )
      return;
    const completed = this.improvedCompletion(session, freshTime);
    if (!completed) return;
    const { candle, atr, crossing } = completed;
    if (!crossing || atr === null || !Number.isFinite(atr) || atr <= 0) return;
    if (!this.improved.parameters.tradeWeekends) {
      const day = new Date(
        candle.time + timeframeMs[history.timeframe] + 3 * 60 * 60 * 1000,
      ).getUTCDay();
      if (day === 0 || day === 6) return;
    }
    const stop = candle.close - crossing * this.improved.parameters.stopAtrMultiplier * atr;
    if (!Number.isFinite(stop) || stop <= 0) return;
    return {
      candleTime: candle.time,
      signalTime: candle.time + timeframeMs[history.timeframe],
      targetPosition: crossing,
      strategy: {
        kind: 'improved-surfing',
        close: candle.close,
        atr,
        ema: candle.confirmedEma,
      },
    };
  }

  private improvedCompletion(session: LiveSession<H>, freshTime: number) {
    const indicators = session.indicators;
    if (!indicators || indicators.invalid || !indicators.candles.has(freshTime)) return;
    if ([...indicators.incomplete].some((time) => time <= freshTime)) return;
    const candles = [...indicators.candles.values()];
    if (candles.some((candle) => candle.time > freshTime)) return;
    let state = indicators.anchor;
    let previousTime = indicators.anchorTime;
    try {
      for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
        if (!candle.complete || candle.time > freshTime) continue;
        if (!Number.isFinite(candle.time) || candle.time <= previousTime) return;
        previousTime = candle.time;
        const observed = observeCompleted(state, candle, this.improved!.parameters.atrPeriod);
        state = observed.state;
        if (candle.time === freshTime)
          return { candle, atr: state.atr, crossing: observed.crossing };
      }
    } catch {
      return;
    }
  }

  private rememberImprovedCandles(session: LiveSession<H>, history: H): boolean {
    const incoming = (history as unknown as MarketHistory).candles;
    if (!Array.isArray(incoming)) return true;
    const cache = (session.indicators ??= {
      anchor: initialIndicators(),
      anchorTime: -Infinity,
      candles: new Map(),
      incomplete: new Set(),
      invalid: false,
    });
    if (cache.invalid) return true;
    const seen = new Set<number>();
    let newest = Math.max(cache.anchorTime, ...cache.candles.keys());
    const evictOldest = () => {
      if (cache.candles.size + cache.incomplete.size <= 4096) return true;
      const oldest = [...cache.candles.values()].sort((a, b) => a.time - b.time)[0];
      if (!oldest || [...cache.incomplete].some((time) => time <= oldest.time)) return false;
      try {
        cache.anchor = observeCompleted(
          cache.anchor,
          oldest,
          this.improved!.parameters.atrPeriod,
        ).state;
        cache.anchorTime = oldest.time;
        cache.candles.delete(oldest.time);
      } catch {
        cache.invalid = true;
        session.revision = (session.revision ?? 0) + 1;
      }
      return true;
    };
    for (const candle of incoming) {
      if (!candle.complete) {
        if (cache.candles.has(candle.time) || candle.time <= cache.anchorTime) {
          cache.invalid = true;
          session.revision = (session.revision ?? 0) + 1;
          return true;
        }
        if (Number.isFinite(candle.time) && !cache.incomplete.has(candle.time)) {
          cache.incomplete.add(candle.time);
          if (candle.time < newest) session.revision = (session.revision ?? 0) + 1;
        }
        if (!evictOldest()) return false;
        if (cache.invalid) return true;
        continue;
      }
      if (
        !Number.isFinite(candle.time) ||
        seen.has(candle.time) ||
        candle.time <= cache.anchorTime
      ) {
        cache.invalid = true;
        session.revision = (session.revision ?? 0) + 1;
        return true;
      }
      seen.add(candle.time);
      cache.incomplete.delete(candle.time);
      const previous = cache.candles.get(candle.time);
      if (
        previous
          ? previous.open !== candle.open ||
            previous.high !== candle.high ||
            previous.low !== candle.low ||
            previous.close !== candle.close ||
            previous.confirmedEma !== candle.confirmedEma
          : newest > candle.time
      )
        session.revision = (session.revision ?? 0) + 1;
      cache.candles.set(candle.time, candle);
      newest = Math.max(newest, candle.time);
      if (!evictOldest()) return false;
      if (cache.invalid) return true;
    }
    return true;
  }

  private async tradeGuarded(
    run: Run<C, H>,
    session: LiveSession<H>,
    signal: LiveSignal,
    intent: OrderIntent,
    revision: number,
    increase?: {
      proof: CloseProofRef;
      plan: StopPlan;
      fallback: StopPlan;
      nextPosition: ImprovedPosition;
    },
  ) {
    const store = this.store.protection;
    if (!store) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    const position =
      increase?.nextPosition ??
      openImprovedPosition(
        intent.direction === 'buy' ? 1 : -1,
        Number(signal.strategy.close),
        Number(signal.strategy.atr),
        intent.lots,
        this.improved!.parameters,
      );
    const origin = randomUUID();
    const reserved = await store.reserveProtectedEntry(
      intent,
      increase?.plan ?? { id: randomUUID(), stop: position.stop },
      origin,
      increase,
    );
    if (!reserved.ok) throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    const restoreAfterSkip = async (protection: StoredProtection | null) => {
      if (!increase || !protection) return this.publish();
      this.protection = protection;
      if (await this.recheckPosition(run.config, intent.fromPosition))
        throw new RobotError('ROBOT_POSITION_CHANGED');
      await this.submitInitialStop(run, protection, true);
      this.finishLiveStop(run);
    };
    const release = async (status: EntryBeforeSendStatus) => {
      const result = await store
        .settleProtectedEntry(reserved.value.ref, { kind: 'not-sent', origin, status })
        .catch(() => null);
      if (!result?.ok) await this.reloadGuardedAfterFailure(intent, unknownOrder);
      else await restoreAfterSkip(result.value.protection);
    };
    let eligible: { start: number; end: number } | null;
    try {
      eligible = await this.improved!.session(run.config, signal.signalTime);
    } catch (error) {
      await release(
        this.mode === 'stopped'
          ? 'stopped-before-send'
          : this.run !== run || run.session !== session
            ? 'feed-lost-before-send'
            : 'session-check-failed-before-send',
      );
      throw error;
    }
    const accountError = await this.recheckPosition(run.config, intent.fromPosition);
    const now = this.now();
    if (
      this.run !== run ||
      run.session !== session ||
      accountError ||
      (session.revision ?? 0) !== revision ||
      session.indicators?.invalid ||
      (session.latestCompleted ?? -Infinity) > signal.candleTime ||
      signal.candleTime + 2 * timeframeMs[run.config.timeframe] <= now ||
      !this.eligibleSession(eligible, signal.signalTime, now)
    ) {
      await release(
        this.mode === 'stopped'
          ? 'stopped-before-send'
          : this.run !== run || run.session !== session
            ? 'feed-lost-before-send'
            : accountError
              ? 'account-check-failed-before-send'
              : !this.eligibleSession(eligible, signal.signalTime, now)
                ? 'session-ended-before-send'
                : 'stale-signal-before-send',
      );
      if (accountError && this.run === run) this.pause(run, accountError);
      return;
    }
    const begun = await store.beginEntrySubmit(reserved.value.ref, origin).catch(() => null);
    if (!begun?.ok) {
      await this.reloadGuardedAfterFailure(intent, unknownOrder);
      return;
    }
    const marginOk =
      !increase ||
      (await this.improved!.protection.canIncrease!(run.config, intent).catch(() => false));
    const finalAccountError = await this.recheckPosition(run.config, intent.fromPosition);
    const sendNow = this.now();
    const invalidStatus =
      this.mode === 'stopped'
        ? 'stopped-before-send'
        : this.run !== run || run.session !== session
          ? 'feed-lost-before-send'
          : finalAccountError || !marginOk
            ? 'account-check-failed-before-send'
            : (session.revision ?? 0) !== revision ||
                session.indicators?.invalid ||
                (session.latestCompleted ?? -Infinity) > signal.candleTime ||
                signal.candleTime + 2 * timeframeMs[run.config.timeframe] <= sendNow
              ? 'stale-signal-before-send'
              : !this.eligibleSession(eligible, signal.signalTime, sendNow)
                ? 'session-ended-before-send'
                : null;
    if (invalidStatus) {
      const cancelled = await store
        .cancelEntryBeforeSend(begun.value.owner, invalidStatus)
        .catch(() => null);
      if (!cancelled?.ok) {
        await this.reloadGuardedAfterFailure(intent, unknownOrder);
      } else await restoreAfterSkip(cancelled.value.protection);
      if (finalAccountError && this.run === run) this.pause(run, finalAccountError);
      return;
    }
    if (!store.consumeEntrySubmit(begun.value.owner)) {
      await this.reloadGuardedAfterFailure(intent, unknownOrder);
      return;
    }
    let posted: Awaited<ReturnType<Broker['submit']>> | null = null;
    try {
      posted = await this.broker.submit(run.config.token, intent);
    } catch {
      // The original request must be reconciled even if dispatch threw synchronously.
    }
    const { state, account } = await this.readOrderAndAccount(
      run.config,
      intent,
      posted?.brokerOrderId ?? null,
    );
    const lowerBound = posted?.executedLots ?? 0;
    const contradictory = lowerBound > 0 && (state?.executedLots ?? 0) < lowerBound;
    const details = contradictory
      ? { ...unknownOrder, brokerOrderId: posted?.brokerOrderId ?? null, executedLots: lowerBound }
      : (state ?? { ...unknownOrder, ...posted });
    const reason =
      !posted || posted.brokerStatus === 'unknown' || contradictory
        ? 'ROBOT_ORDER_SUBMISSION_UNCERTAIN'
        : posted.brokerStatus !== 'filled'
          ? 'ROBOT_ORDER_UNRESOLVED'
          : orderProblem(intent, state?.brokerStatus === 'filled' ? state : null, account);
    this.position = account?.position ?? null;
    const settled = await store
      .settleProtectedEntry(begun.value.ref, {
        kind: 'observed',
        result: {
          ...details,
          position: this.position,
          status: reason ? 'unconfirmed' : 'confirmed',
        },
        ...(account && {
          account: { accountId: intent.accountId, instrumentUid: intent.instrumentUid, ...account },
        }),
      })
      .catch(() => null);
    if (!settled?.ok) {
      await this.reloadGuardedAfterFailure(intent, details);
      return;
    }
    if (!settled.value.protection || reason) {
      this.pauseForOrder(intent, details, false, reason ?? 'ROBOT_ORDER_UNRESOLVED');
      return;
    }
    this.protection = settled.value.protection;
    // A lost entry response is never authority to initiate another side effect.
    if (this.run !== run && !increase) {
      if (this.run === run) this.pause(run, 'ROBOT_PROTECTION_UNRESOLVED');
      else this.publish();
      return;
    }
    run.improvedPosition = position;
    await this.submitInitialStop(run, settled.value.protection, !!increase);
    this.finishLiveStop(run);
  }

  private finishLiveStop(run: Run<C, H>) {
    if (this.run !== run) return this.publish();
    if (!this.improved!.protection.closeEvidence)
      this.pause(run, 'ROBOT_PROTECTION_REQUIRES_RECONCILIATION');
    else {
      this.reason =
        this.protection?.state === 'not-sent' || this.protection?.state === 'rejected'
          ? 'ROBOT_PROTECTION_UNRESOLVED'
          : null;
      this.publish();
    }
  }

  private async reloadGuardedAfterFailure(order: OrderIntent, state: BrokerOrder) {
    const store = this.store.protection!;
    let entry: GuardedEntry | null = null;
    let protection: StoredProtection | null = null;
    let released = false;
    try {
      [entry, protection] = await Promise.all([store.loadProtectedEntry(), store.loadProtection()]);
      if (!entry && !protection) {
        const history = await this.store.history(order.accountId);
        released = history.some((item) => {
          if (!item || typeof item !== 'object') return false;
          const record = item as Partial<RecoveredOrder>;
          return (
            record.id === order.id &&
            record.accountId === order.accountId &&
            record.instrumentUid === order.instrumentUid &&
            (record.status?.endsWith('-before-send') === true ||
              (record.status === 'reconciled' &&
                record.executedLots === 0 &&
                (record.brokerStatus === 'cancelled' || record.brokerStatus === 'rejected')))
          );
        });
      }
    } catch {
      // An unreadable durable state cannot authorize any further action.
    }
    if (released) {
      if (this.recovery?.order.id === order.id) {
        this.recovery = undefined;
        if (this.reason?.startsWith('ROBOT_ORDER_')) this.reason = null;
      }
      this.publish();
      return;
    }
    if (!entry && protection?.entryOrderId === order.id && sameSelection(protection, order)) {
      this.clearRun();
      if (this.mode !== 'stopped') this.mode = 'paused';
      this.recovery = undefined;
      this.protection = protection;
      this.reason = 'ROBOT_PROTECTION_UNRESOLVED';
      this.publish();
      return;
    }
    this.pauseForOrder(order, state, false, 'ROBOT_ORDER_UNRESOLVED');
  }

  private async submitInitialStop(
    run: Run<C, H>,
    protection: StoredProtection,
    finishReplacement = false,
  ) {
    const store = this.store.protection!;
    const begun = await store.beginStopSubmit({
      accountId: protection.accountId,
      instrumentUid: protection.instrumentUid,
      stopId: protection.id,
      version: protection.version,
    });
    if (!begun.ok) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    this.protection = begun.value.protection;
    let outcome: 'confirmed' | 'not-sent' | 'rejected' | 'unconfirmed' = 'not-sent';
    if (this.run === run || finishReplacement) {
      try {
        outcome = await this.improved!.protection.submit(run.config, begun.value.protection);
      } catch {
        outcome = 'unconfirmed';
      }
    }
    const finished = await store.finishStopSubmit(begun.value.owner, outcome);
    if (!finished.ok) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    this.protection = finished.value;
  }

  private async reconcileGuardedEntry(recovery: Recovery) {
    const store = this.store.protection;
    if (!store) throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
    const entry: GuardedEntry | null = await store.loadProtectedEntry();
    if (!entry || entry.order.id !== recovery.order.id)
      throw new RobotError('ROBOT_ORDER_UNRESOLVED');
    const config = await this.loadRecoveryAccount(entry.order);
    if (!sameSelection(config, entry.order)) throw new RobotError('ROBOT_SELECTION_CHANGED');
    const { state, account } = await this.readOrderAndAccount(config, entry.order, null);
    // An unsuccessful settlement may not have persisted the submission evidence.
    // Never let a later, contradictory lookup erase the in-process lower bound.
    const lowerBound = recovery.state.executedLots;
    if (
      !state?.brokerOrderId ||
      state.executedLots === null ||
      (lowerBound === null && state.executedLots === 0) ||
      (lowerBound !== null && state.executedLots < lowerBound)
    ) {
      this.reason = 'ROBOT_ORDER_UNRESOLVED';
      return;
    }
    const reason = orderProblem(entry.order, state, account);
    const details = state ?? unknownOrder;
    this.position = account?.position ?? null;
    const settled = await store
      .settleProtectedEntry(entry.ref, {
        kind: 'observed',
        result: {
          ...details,
          position: this.position,
          status: reason ? 'unconfirmed' : 'reconciled',
        },
        ...(details.brokerStatus === 'cancelled' && { recoverPartial: true }),
        ...(account && {
          account: { accountId: config.accountId, instrumentUid: config.instrumentUid, ...account },
        }),
      })
      .catch(() => null);
    if (!settled?.ok) {
      await this.reloadGuardedAfterFailure(entry.order, details);
      return;
    }
    this.protection = settled.value.protection;
    this.reason = this.protection ? 'ROBOT_PROTECTION_UNRESOLVED' : reason;
    if (!(await store.loadProtectedEntry())) this.recovery = undefined;
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
    status:
      | 'stopped-before-send'
      | 'feed-lost-before-send'
      | 'account-check-failed-before-send'
      | 'stale-signal-before-send'
      | 'session-check-failed-before-send'
      | 'session-ended-before-send',
  ) {
    return this.store.record(intent.id, { ...unknownOrder, status, position: this.position });
  }

  private async readOrderAndAccount(
    config: RecoveryAccount,
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
    if (this.mode !== 'stopped' || order.context.type === 'manual-close') this.mode = 'paused';
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

export type RobotService = Pick<Robot, keyof Robot>;
