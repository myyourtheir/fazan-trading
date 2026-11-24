import type {
  AccountEvidence,
  Attempt,
  CloseLink,
  CloseBeforeSendReason,
  CloseProofRef,
  CloseReservationOwner,
  CloseSettlement,
  CloseSubmitOwner,
  EvidenceKind,
  EvidenceResult,
  EntryRef,
  EntrySettlement,
  EntrySettlementValue,
  EntrySubmitOwner,
  EntryBeforeSendStatus,
  GuardedEntry,
  LinkedOrder,
  ProtectionIntent,
  ProtectionTransactions,
  StopRef,
  StopSubmitOwner,
  StopPlan,
  StoredProtection,
  Write,
} from './protection-transactions.js';
import type { OrderIntent, OrderResult, RecoveredOrder, TradingStore } from './robot.js';

export type ProtectionLedgerState = {
  protection: StoredProtection | null;
  orders: Record<string, RecoveredOrder>;
  settledOrders: Record<string, true>;
  proof: { attemptId: string; version: number; consumed: boolean } | null;
  definiteChildren: Record<string, { executedLots: number; terminal: boolean }>;
  definiteParent: 'never-triggered' | 'triggered' | null;
  stopSubmitPending: boolean;
  entry: (GuardedEntry & { origin: string; maxFill: number; fallback?: StopPlan }) | null;
  guardedIds: Record<string, true>;
};
type State = ProtectionLedgerState;
const blocked = { ok: false, reason: 'blocked' } as const;
const stale = { ok: false, reason: 'stale' } as const;
const conflict = { ok: false, reason: 'order-conflict' } as const;

export function emptyProtectionLedger(): State {
  return {
    protection: null,
    orders: {},
    settledOrders: {},
    proof: null,
    definiteChildren: {},
    definiteParent: null,
    stopSubmitPending: false,
    entry: null,
    guardedIds: {},
  };
}

export function protectionLedgerBlocksTrading(state: State): boolean {
  return protectionLedgerAccount(state) !== undefined;
}

export function protectionLedgerAccount(state: State): string | undefined {
  return (
    state.protection?.accountId ??
    state.entry?.order.accountId ??
    Object.values(state.orders).find((order) => isBlocking(state, order))?.accountId
  );
}

export interface ProtectionLedgerPersistence {
  read(): Promise<State>;
  /** Serialize with other writers, persist only successful changes and return after commit. */
  write<T>(transition: (state: State) => Write<T>): Promise<Write<T>>;
}

export class ProtectionLedger implements ProtectionTransactions, TradingStore<RecoveredOrder> {
  public readonly protection: ProtectionTransactions = this;
  private readonly stopOwners = new WeakSet<StopSubmitOwner>();
  private readonly entryOwners = new WeakSet<EntrySubmitOwner>();
  private readonly closeReservations = new WeakMap<
    CloseReservationOwner,
    { link: CloseLink; version: number }
  >();
  private readonly closeSubmits = new WeakMap<
    CloseSubmitOwner,
    { link: CloseLink; version: number }
  >();
  public constructor(private readonly persistence: ProtectionLedgerPersistence) {}

  public async reserve(order: OrderIntent): Promise<boolean> {
    const result = await this.write((s) => {
      if (s.entry || s.protection || hasBlockingOrder(s) || s.orders[order.id]) return blocked;
      s.orders[order.id] = {
        ...orderIntent(order),
        status: 'reserved',
        brokerOrderId: null,
        brokerStatus: 'unknown',
        executedLots: null,
        executions: [],
        position: null,
      };
      return { ok: true, value: true };
    });
    return result.ok;
  }

  public async record(id: string, result: OrderResult): Promise<void> {
    const written = await this.write((s) => {
      const order = s.orders[id];
      if (!order || order.protectionLink || s.guardedIds[id]) return blocked;
      if (
        result.status === 'unconfirmed' &&
        !isBlocking(s, order) &&
        (s.protection || hasBlockingOrder(s))
      )
        return blocked;
      const { status, brokerOrderId, brokerStatus, executedLots, executions, position } = result;
      Object.assign(order, {
        status,
        brokerOrderId,
        brokerStatus,
        executedLots,
        executions,
        position,
      });
      return { ok: true, value: undefined };
    });
    if (!written.ok) throw new Error('order not found or protected');
  }

  public async hasUnresolved(): Promise<boolean> {
    return hasBlockingOrder(await this.persistence.read());
  }

  public async unresolved(): Promise<RecoveredOrder | null> {
    const state = await this.persistence.read();
    return structuredClone(
      state.entry?.order ??
        Object.values(state.orders).find((order) => isBlocking(state, order)) ??
        null,
    );
  }

  public async history(accountId?: string): Promise<RecoveredOrder[]> {
    return structuredClone(
      Object.values((await this.persistence.read()).orders).filter(
        (order) => accountId === undefined || order.accountId === accountId,
      ),
    );
  }

  public async loadProtection(): Promise<StoredProtection | null> {
    return structuredClone((await this.persistence.read()).protection);
  }

  public async reserveProtectedEntry(
    order: OrderIntent,
    plan: StopPlan,
    origin: string,
    replacing?: { proof: CloseProofRef; fallback: StopPlan },
  ): Promise<Write<GuardedEntry>> {
    return this.write((s) => {
      const side = order.direction === 'buy' ? 1 : -1;
      const old = s.protection;
      const fallback = replacing?.fallback;
      if (
        s.entry ||
        hasBlockingOrder(s) ||
        s.orders[order.id] ||
        !order.id ||
        !order.accountId ||
        !order.instrumentUid ||
        !origin ||
        !plan.id ||
        !Number.isFinite(plan.stop) ||
        plan.stop <= 0 ||
        !Number.isSafeInteger(order.lots) ||
        order.lots <= 0 ||
        order.targetPosition !== order.fromPosition + side * order.lots ||
        !Number.isSafeInteger(order.targetPosition) ||
        Math.abs(order.targetPosition) > 2_147_483_647 ||
        (replacing
          ? !this.matches(old, replacing.proof) ||
            !this.validProof(s, replacing.proof) ||
            old.closeObservation?.status !== 'never-triggered' ||
            !fallback?.id ||
            fallback.id === old.id ||
            fallback.id === plan.id ||
            plan.id === old.id ||
            fallback.stop !== old.stop ||
            side * (plan.stop - old.stop) < 0 ||
            order.accountId !== old.accountId ||
            order.instrumentUid !== old.instrumentUid ||
            old.direction === order.direction ||
            order.fromPosition !== side * old.lots
          : old !== null || order.fromPosition !== 0)
      )
        return blocked;
      const stored: RecoveredOrder = {
        ...orderIntent(order),
        status: 'reserved',
        brokerOrderId: null,
        brokerStatus: 'unknown',
        executedLots: null,
        executions: [],
        position: null,
      };
      s.orders[order.id] = stored;
      s.guardedIds[order.id] = true;
      s.entry = {
        order: stored,
        plan: structuredClone(plan),
        ref: {
          accountId: order.accountId,
          instrumentUid: order.instrumentUid,
          orderId: order.id,
          version: 1,
        },
        submitStarted: false,
        origin,
        maxFill: 0,
        ...(fallback && { fallback: structuredClone(fallback) }),
      };
      if (replacing) s.proof!.consumed = true;
      return { ok: true, value: this.entryView(s.entry) };
    });
  }

  public async loadProtectedEntry(): Promise<GuardedEntry | null> {
    const entry = (await this.persistence.read()).entry;
    return entry ? structuredClone(this.entryView(entry)) : null;
  }

  public async beginEntrySubmit(
    expected: EntryRef,
    origin: string,
  ): Promise<Write<GuardedEntry & { owner: EntrySubmitOwner }>> {
    const result = await this.write((s) => {
      const e = s.entry;
      if (!this.entryMatches(e, expected)) return stale;
      if (e.origin !== origin || e.submitStarted) return blocked;
      e.submitStarted = true;
      e.ref.version++;
      return { ok: true, value: this.entryView(e) };
    });
    if (!result.ok) return result;
    const owner = Object.freeze({ ...result.value.ref }) as EntrySubmitOwner;
    this.entryOwners.add(owner);
    return { ok: true, value: { ...result.value, owner } };
  }

  public consumeEntrySubmit(owner: EntrySubmitOwner): boolean {
    return this.entryOwners.delete(owner);
  }

  public async cancelEntryBeforeSend(
    owner: EntrySubmitOwner,
    status: EntryBeforeSendStatus,
  ): Promise<Write<EntrySettlementValue>> {
    if (!this.entryOwners.delete(owner)) return blocked;
    return this.write((s) => {
      const e = s.entry;
      if (!this.entryMatches(e, owner) || !e.submitStarted) return stale;
      const order = s.orders[e.order.id];
      order.status = status;
      s.entry = null;
      if (e.fallback) this.installEntryStop(s, order, e.fallback, order.fromPosition);
      return { ok: true, value: { order, protection: s.protection } };
    });
  }

  public async settleProtectedEntry(
    expected: EntryRef,
    settlement: EntrySettlement,
  ): Promise<Write<EntrySettlementValue>> {
    return this.write((s) => {
      const e = s.entry;
      if (!this.entryMatches(e, expected)) return stale;
      const order = s.orders[e.order.id];
      if (settlement.kind === 'not-sent') {
        if (e.submitStarted || e.origin !== settlement.origin) return blocked;
        order.status = settlement.status ?? 'stopped-before-send';
        s.entry = null;
        if (e.fallback) this.installEntryStop(s, order, e.fallback, order.fromPosition);
        return { ok: true, value: { order, protection: s.protection } };
      }
      if (!e.submitStarted) return blocked;
      const r = settlement.result;
      const executionIds = new Set(r.executions.map((execution) => execution.tradeId));
      const executionLots = r.executions.reduce((sum, execution) => sum + execution.lots, 0);
      const missingRows = r.executedLots !== null && r.executedLots > 0 && !r.executions.length;
      if (
        !Number.isSafeInteger(executionLots) ||
        executionLots > order.lots ||
        (r.executedLots !== null &&
          (!Number.isSafeInteger(r.executedLots) ||
            r.executedLots < e.maxFill ||
            r.executedLots > order.lots ||
            (!missingRows && executionLots !== r.executedLots) ||
            (r.brokerStatus === 'rejected' && r.executedLots > 0) ||
            (r.brokerStatus === 'filled' && r.executedLots !== order.lots))) ||
        executionIds.size !== r.executions.length ||
        (r.executedLots !== null &&
          !missingRows &&
          order.executions.some((previous) => {
            const current = r.executions.find(
              (execution) => execution.tradeId === previous.tradeId,
            );
            return (
              !current ||
              current.lots !== previous.lots ||
              current.price !== previous.price ||
              current.time !== previous.time
            );
          })) ||
        r.executions.some(
          (execution) =>
            !execution.tradeId ||
            !Number.isSafeInteger(execution.lots) ||
            execution.lots <= 0 ||
            execution.price === null ||
            !Number.isFinite(execution.price) ||
            execution.price <= 0 ||
            !Number.isFinite(execution.time),
        )
      )
        return blocked;
      // Incomplete evidence still establishes a lower bound, but cannot replace
      // the last verified count/list pair or authorize a handoff.
      e.maxFill = Math.max(e.maxFill, r.executedLots ?? 0, executionLots);
      Object.assign(order, {
        status: r.status,
        brokerOrderId: r.brokerOrderId,
        brokerStatus: r.brokerStatus,
        executedLots: r.executedLots === null || missingRows ? order.executedLots : r.executedLots,
        executions: r.executedLots === null || missingRows ? order.executions : r.executions,
        position: r.position,
      });
      e.order = order;
      e.ref.version++;
      const account = settlement.account;
      const matching = account && this.accountMatches(order, account) && !account.activeOrders;
      const terminal =
        r.brokerStatus === 'filled' ||
        r.brokerStatus === 'rejected' ||
        r.brokerStatus === 'cancelled';
      const definite = r.status === 'confirmed' || r.status === 'reconciled';
      const signed = order.fromPosition + (order.direction === 'buy' ? e.maxFill : -e.maxFill);
      if (
        definite &&
        terminal &&
        matching &&
        !missingRows &&
        r.executedLots !== null &&
        r.executedLots === e.maxFill &&
        r.position === signed &&
        account.position === signed
      ) {
        if (
          e.maxFill === 0 &&
          r.status === 'reconciled' &&
          (r.brokerStatus === 'rejected' || r.brokerStatus === 'cancelled')
        ) {
          s.entry = null;
          if (e.fallback) this.installEntryStop(s, order, e.fallback, signed);
        } else if (
          e.maxFill > 0 &&
          ((r.brokerStatus === 'filled' && e.maxFill === order.lots) ||
            (settlement.recoverPartial && r.brokerStatus === 'cancelled' && e.maxFill < order.lots))
        ) {
          this.installEntryStop(s, order, e.plan, signed);
          s.entry = null;
        }
      }
      return { ok: true, value: { order, protection: s.protection } };
    });
  }

  public async reserveProtection(intent: ProtectionIntent): Promise<Write<StoredProtection>> {
    return this.write((s) => {
      if (s.entry || s.protection || hasBlockingOrder(s)) return blocked;
      if (
        !intent.id ||
        !intent.accountId ||
        !intent.instrumentUid ||
        !Number.isSafeInteger(intent.lots) ||
        intent.lots <= 0
      )
        return blocked;
      s.protection = {
        ...intent,
        state: 'not-sent',
        version: 1,
        pendingAttempt: null,
        completedAttempt: null,
      };
      resetStopEvidence(s);
      return { ok: true, value: s.protection };
    });
  }

  public async beginStopSubmit(
    expected: StopRef,
  ): Promise<Write<{ protection: StoredProtection; owner: StopSubmitOwner }>> {
    const result = await this.change(expected, (p, s) => {
      if (p.pendingAttempt || s.stopSubmitPending || p.state !== 'not-sent') return false;
      p.state = 'unconfirmed';
      s.stopSubmitPending = true;
      return true;
    });
    if (!result.ok) return result;
    const p = result.value;
    const owner = Object.freeze({
      accountId: p.accountId,
      instrumentUid: p.instrumentUid,
      stopId: p.id,
      version: p.version,
    }) as StopSubmitOwner;
    this.stopOwners.add(owner);
    return { ok: true, value: { protection: p, owner } };
  }

  public async finishStopSubmit(
    owner: StopSubmitOwner,
    outcome: 'confirmed' | 'not-sent' | 'rejected' | 'unconfirmed',
  ): Promise<Write<StoredProtection>> {
    if (!this.stopOwners.delete(owner)) return blocked;
    return this.change(owner, (p, s) => {
      if (p.pendingAttempt || !s.stopSubmitPending || p.state !== 'unconfirmed') return false;
      p.state = outcome;
      s.stopSubmitPending = false;
      return true;
    });
  }

  public async beginCancellation(expected: StopRef): Promise<Write<StoredProtection>> {
    return this.change(expected, (p, s) => {
      if (
        p.pendingAttempt ||
        s.stopSubmitPending ||
        p.cancellationPending ||
        (p.state !== 'confirmed' && p.state !== 'unconfirmed')
      )
        return false;
      p.cancellationPending = true;
      return true;
    });
  }

  public async beginEvidence<K extends EvidenceKind>(
    expected: StopRef,
    kind: K,
    attemptId: string,
  ): Promise<Write<Attempt<K>>> {
    return this.write((s) => {
      const p = s.protection;
      if (!this.matches(p, expected)) return stale;
      if (p.pendingAttempt || !attemptId || hasBlockingOrder(s)) return blocked;
      p.version++;
      const attempt: Attempt<K> = {
        accountId: p.accountId,
        instrumentUid: p.instrumentUid,
        stopId: p.id,
        version: p.version,
        attemptId,
        kind,
      };
      p.pendingAttempt = attempt;
      p.completedAttempt = null;
      s.proof = null;
      return { ok: true, value: attempt };
    });
  }

  public async finishEvidence(
    evidence: Extract<EvidenceResult, { kind: 'close' }>,
  ): Promise<Write<StoredProtection & { closeProof: CloseProofRef | null }>>;
  public async finishEvidence(
    evidence: Extract<EvidenceResult, { kind: 'lookup' }>,
  ): Promise<Write<StoredProtection>>;
  public async finishEvidence(
    evidence: EvidenceResult,
  ): Promise<Write<StoredProtection & { closeProof?: CloseProofRef | null }>> {
    return this.write((s) => {
      const p = s.protection;
      if (!this.matches(p, evidence)) return stale;
      if (
        !p.pendingAttempt ||
        p.pendingAttempt.attemptId !== evidence.attemptId ||
        p.pendingAttempt.kind !== evidence.kind
      )
        return blocked;
      p.pendingAttempt = null;
      p.completedAttempt = this.attempt(evidence);
      if (evidence.kind === 'lookup') {
        const previous = p.observation;
        const observed = evidence.observation;
        if (
          (observed.status === 'unknown' && previous && previous.status !== 'unknown') ||
          (previous?.status === 'triggered' && observed.status === 'absent')
        ) {
          p.observation = previous;
        } else if (
          previous?.status === 'triggered' &&
          observed.status === 'triggered' &&
          previous.childId === observed.childId &&
          observed.childStatus === 'unknown'
        ) {
          p.observation = { ...observed, childStatus: previous.childStatus };
        } else {
          p.observation = structuredClone(observed);
        }
        if (evidence.observation.status === 'triggered') {
          if (!usableChildId(evidence.observation.childId)) {
            p.evidenceConflict = true;
            p.version++;
            return { ok: true, value: p };
          }
          p.childIds = [...new Set([...(p.childIds ?? []), evidence.observation.childId])];
          if (s.definiteParent === 'never-triggered') p.evidenceConflict = true;
          s.definiteParent = 'triggered';
          if (evidence.observation.childStatus === 'active') {
            const old = p.childObservations?.[evidence.observation.childId];
            if (old?.terminal || s.definiteChildren[evidence.observation.childId]?.terminal)
              p.evidenceConflict = true;
            p.childObservations ??= {};
            p.childObservations[evidence.observation.childId] = {
              terminal: false,
              executedLots: old?.executedLots ?? null,
            };
          }
        }
        if (evidence.observation.status === 'absent' && !s.stopSubmitPending) p.state = 'absent';
      } else {
        const ids = new Set(p.childIds ?? []);
        const observations = p.childObservations ?? {};
        if (evidence.stopObservation?.status === 'triggered') {
          if (usableChildId(evidence.stopObservation.childId)) {
            ids.add(evidence.stopObservation.childId);
            s.definiteParent = 'triggered';
          }
          p.evidenceConflict = true;
        }
        if (
          evidence.stopObservation &&
          evidence.stopObservation.status !== 'unknown' &&
          p.observation?.status !== 'triggered'
        ) {
          p.observation = structuredClone(evidence.stopObservation);
        }
        if (evidence.parent.status === 'triggered') {
          const supplied = new Set(evidence.parent.childIds);
          if (
            !supplied.size ||
            [...supplied].some((id) => !usableChildId(id)) ||
            supplied.size !== evidence.parent.childIds.length ||
            [...ids].some((id) => !supplied.has(id)) ||
            evidence.children.some((child) => !supplied.has(child.childId))
          )
            p.evidenceConflict = true;
          for (const id of supplied) if (usableChildId(id)) ids.add(id);
          // This evidence was read after the previous active observation. A
          // trigger during cancellation supersedes that earlier snapshot.
          const first = evidence.parent.childIds[0];
          if (!p.evidenceConflict && p.observation?.status === 'active' && first) {
            const child = evidence.children.find(({ childId }) => childId === first);
            p.observation = {
              status: 'triggered',
              childId: first,
              childStatus: child?.terminal ? 'terminal' : 'unknown',
            };
          }
        }
        for (const child of evidence.children) {
          if (!usableChildId(child.childId)) {
            p.evidenceConflict = true;
            continue;
          }
          ids.add(child.childId);
          const old = observations[child.childId];
          const definite = s.definiteChildren[child.childId];
          if (
            (child.executedLots !== null &&
              (!Number.isSafeInteger(child.executedLots) || child.executedLots < 0)) ||
            (old &&
              ((old.terminal && !child.terminal) ||
                (old.terminal &&
                  old.executedLots !== null &&
                  child.executedLots !== null &&
                  old.executedLots !== child.executedLots) ||
                (old.executedLots !== null &&
                  child.executedLots !== null &&
                  child.executedLots < old.executedLots))) ||
            (definite &&
              child.executedLots !== null &&
              (child.executedLots < definite.executedLots ||
                (definite.terminal && child.executedLots !== definite.executedLots)))
          )
            p.evidenceConflict = true;
          if (
            child.executedLots !== null &&
            Number.isSafeInteger(child.executedLots) &&
            child.executedLots >= 0
          ) {
            s.definiteChildren[child.childId] = {
              executedLots: Math.max(definite?.executedLots ?? 0, child.executedLots),
              terminal: !!definite?.terminal || child.terminal || !!old?.terminal,
            };
          }
          observations[child.childId] = {
            terminal: old?.terminal || child.terminal,
            executedLots: child.terminal
              ? child.executedLots
              : (child.executedLots ?? old?.executedLots ?? null),
          };
        }
        if (s.definiteParent === 'triggered' && evidence.parent.status === 'never-triggered')
          p.evidenceConflict = true;
        if (ids.size > 0 && evidence.parent.status === 'never-triggered') p.evidenceConflict = true;
        if (s.definiteParent === 'never-triggered' && evidence.parent.status === 'triggered')
          p.evidenceConflict = true;
        if (
          evidence.parent.status === 'triggered' ||
          (evidence.parent.status === 'never-triggered' && parentCannotFire(evidence, p))
        ) {
          s.definiteParent = evidence.parent.status;
        }
        p.closeObservation = structuredClone(evidence.parent);
        p.childIds = [...ids];
        p.childObservations = observations;
      }
      p.version++;
      if (evidence.kind === 'lookup') return { ok: true, value: p };
      const parentStopped = evidence.parent.status === 'triggered' || parentCannotFire(evidence, p);
      const safe =
        !s.stopSubmitPending &&
        parentStopped &&
        p.observation?.status !== 'active' &&
        !p.evidenceConflict &&
        evidence.parent.status !== 'unknown' &&
        (p.childIds ?? []).every(
          (id) =>
            evidence.children.filter((child) => child.childId === id && observationsSafe(child))
              .length === 1,
        ) &&
        evidence.children.length === (p.childIds ?? []).length &&
        evidence.children.reduce((sum, child) => sum + (child.executedLots ?? 0), 0) <= p.lots;
      const proof = safe
        ? ({
            accountId: p.accountId,
            instrumentUid: p.instrumentUid,
            stopId: p.id,
            version: p.version,
            attemptId: evidence.attemptId,
          } as CloseProofRef)
        : null;
      s.proof = proof
        ? { attemptId: proof.attemptId, version: proof.version, consumed: false }
        : null;
      return { ok: true, value: { ...p, closeProof: proof } };
    });
  }

  public async reserveProtectedClose(
    proof: CloseProofRef,
    order: OrderIntent,
    account: AccountEvidence,
  ): Promise<
    Write<{
      order: LinkedOrder;
      protection: StoredProtection;
      reservationOwner: CloseReservationOwner;
    }>
  > {
    const result = await this.write((s) => {
      const p = s.protection;
      if (!this.matches(p, proof)) return stale;
      if (
        !this.validProof(s, proof) ||
        !this.accountMatches(p, account) ||
        account.activeOrders ||
        account.position === null ||
        account.position === 0 ||
        !Number.isSafeInteger(account.position)
      )
        return blocked;
      if (hasBlockingOrder(s) || !order.id || s.orders[order.id]) return conflict;
      const childFills = Object.values(p.childObservations ?? {}).reduce(
        (total, child) => total + (child.executedLots ?? 0),
        0,
      );
      if (
        Math.abs(account.position) !== p.lots - childFills ||
        (account.position > 0 ? 'sell' : 'buy') !== p.direction ||
        order.accountId !== p.accountId ||
        order.instrumentUid !== p.instrumentUid ||
        order.fromPosition !== account.position ||
        order.targetPosition !== 0 ||
        order.lots !== Math.abs(account.position) ||
        order.direction !== (account.position > 0 ? 'sell' : 'buy')
      )
        return blocked;
      s.proof!.consumed = true;
      const link = {
        accountId: p.accountId,
        instrumentUid: p.instrumentUid,
        stopId: p.id,
        version: p.version,
        proofAttemptId: proof.attemptId,
        orderId: order.id,
      };
      const value: LinkedOrder = {
        ...orderIntent(order),
        status: 'reserved',
        brokerOrderId: null,
        brokerStatus: 'unknown',
        executedLots: null,
        executions: [],
        position: null,
        protectionLink: link,
        orderVersion: 1,
        submitState: 'unclaimed',
      };
      s.orders[order.id] = value;
      return { ok: true, value: { order: value, protection: p } };
    });
    if (!result.ok) return result;
    const reservationOwner = {} as CloseReservationOwner;
    this.closeReservations.set(reservationOwner, {
      link: { ...result.value.order.protectionLink },
      version: result.value.order.orderVersion,
    });
    return { ok: true, value: { ...result.value, reservationOwner } };
  }

  public async loadProtectedClose(orderId: string): Promise<LinkedOrder | null> {
    const order = (await this.persistence.read()).orders[orderId];
    return structuredClone(isLinked(order) ? order : null);
  }

  public async beginProtectedCloseSubmit(
    owner: CloseReservationOwner,
  ): Promise<Write<{ order: LinkedOrder; submitOwner: CloseSubmitOwner }>> {
    const ref = this.closeReservations.get(owner);
    this.closeReservations.delete(owner);
    if (!ref) return blocked;
    const result = await this.write((s) => {
      const order = s.orders[ref.link.orderId];
      if (
        !isLinked(order) ||
        s.settledOrders[order.id] ||
        !sameLink(order.protectionLink, ref.link) ||
        !this.hasLinkedProtection(s, ref.link) ||
        order.orderVersion !== ref.version ||
        order.submitState !== 'unclaimed'
      )
        return stale;
      order.submitState = 'claimed';
      order.orderVersion++;
      return { ok: true, value: order };
    });
    if (!result.ok) return result;
    const submitOwner = {} as CloseSubmitOwner;
    this.closeSubmits.set(submitOwner, {
      link: { ...result.value.protectionLink },
      version: result.value.orderVersion,
    });
    return { ok: true, value: { order: result.value, submitOwner } };
  }

  public consumeProtectedCloseSubmit(owner: CloseSubmitOwner): boolean {
    // Only this instance can cancel this owner. A remote writer cannot
    // forfeit a claim; authoritative broker evidence implies it already sent.
    return this.closeSubmits.delete(owner);
  }

  public async cancelProtectedCloseBeforeSend(
    owner: CloseReservationOwner | CloseSubmitOwner,
    reason: CloseBeforeSendReason,
  ): Promise<Write<LinkedOrder>> {
    const reservation = this.closeReservations.get(owner as CloseReservationOwner);
    const submission = this.closeSubmits.get(owner as CloseSubmitOwner);
    this.closeReservations.delete(owner as CloseReservationOwner);
    this.closeSubmits.delete(owner as CloseSubmitOwner);
    const ref = reservation ?? submission;
    if (!ref) return blocked;
    return this.write((s) => {
      const order = s.orders[ref.link.orderId];
      if (
        !isLinked(order) ||
        s.settledOrders[order.id] ||
        !sameLink(order.protectionLink, ref.link) ||
        !this.hasLinkedProtection(s, ref.link) ||
        order.orderVersion !== ref.version ||
        order.submitState !== (reservation ? 'unclaimed' : 'claimed')
      )
        return stale;
      order.status = reason;
      order.orderVersion++;
      s.settledOrders[order.id] = true;
      s.proof = null;
      return { ok: true, value: order };
    });
  }

  public async forfeitUnclaimedProtectedClose(
    link: CloseLink,
    version: number,
  ): Promise<Write<LinkedOrder>> {
    return this.write((s) => {
      const order = s.orders[link.orderId];
      if (
        !isLinked(order) ||
        s.settledOrders[order.id] ||
        !sameLink(order.protectionLink, link) ||
        !this.hasLinkedProtection(s, link) ||
        order.orderVersion !== version ||
        order.submitState !== 'unclaimed'
      )
        return stale;
      order.status = 'stopped-before-send';
      order.orderVersion++;
      s.settledOrders[order.id] = true;
      s.proof = null;
      return { ok: true, value: order };
    });
  }

  public async settleProtectedClose(
    link: CloseLink,
    expectedOrderVersion: number,
    settlement: CloseSettlement,
  ): Promise<Write<LinkedOrder>> {
    return this.write((s) => {
      const order = s.orders[link.orderId];
      if (
        !isLinked(order) ||
        s.settledOrders[link.orderId] ||
        !sameLink(order.protectionLink, link) ||
        !this.hasLinkedProtection(s, link) ||
        order.orderVersion !== expectedOrderVersion
      )
        return stale;
      if (order.submitState !== 'claimed' || settlement.kind !== 'observed') return blocked;
      {
        const { status, brokerOrderId, brokerStatus, executedLots, executions, position } =
          settlement.result;
        const executionLots = executions.reduce((sum, execution) => sum + execution.lots, 0);
        const previousLots = order.executions.reduce((sum, execution) => sum + execution.lots, 0);
        if (
          (brokerOrderId && order.brokerOrderId && brokerOrderId !== order.brokerOrderId) ||
          !Number.isSafeInteger(executionLots) ||
          executionLots > order.lots ||
          new Set(executions.map((execution) => execution.tradeId)).size !== executions.length ||
          executions.some(
            (execution) =>
              !execution.tradeId || !Number.isSafeInteger(execution.lots) || execution.lots <= 0,
          ) ||
          (executedLots !== null &&
            (!Number.isSafeInteger(executedLots) ||
              executedLots < Math.max(order.executedLots ?? 0, previousLots, executionLots) ||
              executedLots > order.lots)) ||
          (executions.length > 0 &&
            order.executions.some(
              (previous) =>
                !executions.some(
                  (current) =>
                    current.tradeId === previous.tradeId &&
                    current.lots === previous.lots &&
                    current.price === previous.price &&
                    current.time === previous.time,
                ),
            ))
        )
          return blocked;
        order.status = 'unconfirmed';
        order.brokerOrderId = brokerOrderId ?? order.brokerOrderId;
        order.brokerStatus = brokerStatus;
        order.executedLots = executedLots ?? order.executedLots;
        if (executions.length > 0) order.executions = structuredClone(executions);
        order.position = position;
        const account = settlement.account;
        if (
          (settlement.result.status === 'confirmed' || settlement.result.status === 'reconciled') &&
          settlement.result.brokerStatus === 'filled' &&
          brokerOrderId &&
          settlement.result.executedLots === order.lots &&
          executionLots === order.lots &&
          settlement.result.position === 0 &&
          account &&
          this.accountMatches(order, account) &&
          account.position === 0 &&
          !account.activeOrders
        ) {
          order.status = status;
          s.protection = null;
          s.settledOrders[order.id] = true;
        } else if (
          status === 'reconciled' &&
          brokerStatus === 'cancelled' &&
          brokerOrderId &&
          executedLots !== null &&
          executedLots > 0 &&
          executedLots < order.lots &&
          executionLots === executedLots &&
          position ===
            order.fromPosition + (order.direction === 'buy' ? executedLots : -executedLots) &&
          account &&
          this.accountMatches(order, account) &&
          !account.activeOrders &&
          account.position === position &&
          settlement.remainderStop?.id &&
          settlement.remainderStop.id !== s.protection?.id &&
          settlement.remainderStop.stop === s.protection?.stop
        ) {
          order.status = status;
          s.settledOrders[order.id] = true;
          this.installEntryStop(s, order, settlement.remainderStop, position);
        } else if (
          settlement.result.status === 'reconciled' &&
          (brokerStatus === 'rejected' || brokerStatus === 'cancelled') &&
          brokerOrderId &&
          executedLots === 0 &&
          position === order.fromPosition &&
          account &&
          this.accountMatches(order, account) &&
          account.position === order.fromPosition &&
          !account.activeOrders
        ) {
          order.status = status;
          s.settledOrders[order.id] = true;
          s.proof = null;
        }
      }
      order.orderVersion++;
      return { ok: true, value: order };
    });
  }

  public async clearChildFlat(
    proof: CloseProofRef,
    account: AccountEvidence,
  ): Promise<Write<StoredProtection>> {
    return this.write((s) => {
      const p = s.protection;
      if (!this.matches(p, proof)) return stale;
      const filled = Object.values(p.childObservations ?? {}).reduce(
        (total, child) => total + (child.executedLots ?? 0),
        0,
      );
      if (
        !this.validProof(s, proof) ||
        p.closeObservation?.status !== 'triggered' ||
        !this.accountMatches(p, account) ||
        account.position !== 0 ||
        account.activeOrders ||
        filled !== p.lots ||
        hasBlockingOrder(s)
      )
        return blocked;
      s.proof!.consumed = true;
      s.protection = null;
      return { ok: true, value: p };
    });
  }

  public async replaceProtection(
    proof: CloseProofRef,
    plan: StopPlan,
    account: AccountEvidence,
  ): Promise<Write<StoredProtection>> {
    return this.write((state) => {
      const protection = state.protection;
      if (!this.matches(protection, proof)) return stale;
      const side = protection.direction === 'sell' ? 1 : -1;
      if (
        !this.validProof(state, proof) ||
        protection.closeObservation?.status !== 'never-triggered' ||
        !this.accountMatches(protection, account) ||
        account.activeOrders ||
        account.position !== side * protection.lots ||
        hasBlockingOrder(state) ||
        !Number.isFinite(plan.stop) ||
        plan.stop <= 0 ||
        side * (plan.stop - protection.stop) < 0 ||
        !plan.id ||
        plan.id === protection.id
      )
        return blocked;
      state.protection = {
        id: plan.id,
        accountId: proof.accountId,
        instrumentUid: proof.instrumentUid,
        direction: protection.direction,
        lots: protection.lots,
        stop: plan.stop,
        state: 'not-sent',
        version: 1,
        pendingAttempt: null,
        completedAttempt: null,
      };
      resetStopEvidence(state);
      return { ok: true, value: state.protection };
    });
  }

  private write<T>(fn: (state: State) => Write<T>): Promise<Write<T>> {
    return this.persistence.write(fn);
  }

  private installEntryStop(state: State, order: OrderIntent, plan: StopPlan, position: number) {
    state.protection = {
      id: plan.id,
      entryOrderId: order.id,
      accountId: order.accountId,
      instrumentUid: order.instrumentUid,
      direction: position > 0 ? 'sell' : 'buy',
      lots: Math.abs(position),
      stop: plan.stop,
      state: 'not-sent',
      version: 1,
      pendingAttempt: null,
      completedAttempt: null,
    };
    resetStopEvidence(state);
  }

  private entryView(e: GuardedEntry): GuardedEntry {
    return { order: e.order, ref: e.ref, plan: e.plan, submitStarted: e.submitStarted };
  }

  private entryMatches(e: State['entry'], ref: EntryRef): e is NonNullable<State['entry']> {
    return (
      !!e &&
      e.ref.accountId === ref.accountId &&
      e.ref.instrumentUid === ref.instrumentUid &&
      e.ref.orderId === ref.orderId &&
      e.ref.version === ref.version
    );
  }

  private change(
    expected: StopRef,
    fn: (p: StoredProtection, state: State) => boolean,
  ): Promise<Write<StoredProtection>> {
    return this.write((s) => {
      const p = s.protection;
      if (!this.matches(p, expected)) return stale;
      if (!fn(p, s) || hasBlockingOrder(s)) return blocked;
      p.version++;
      s.proof = null;
      return { ok: true, value: p };
    });
  }

  private matches(p: StoredProtection | null, ref: StopRef): p is StoredProtection {
    return (
      !!p &&
      p.id === ref.stopId &&
      p.accountId === ref.accountId &&
      p.instrumentUid === ref.instrumentUid &&
      p.version === ref.version
    );
  }

  private accountMatches(
    scope: { accountId: string; instrumentUid: string },
    account: AccountEvidence,
  ): boolean {
    return scope.accountId === account.accountId && scope.instrumentUid === account.instrumentUid;
  }

  private hasLinkedProtection(state: State, link: CloseLink): boolean {
    return (
      this.matches(state.protection, link) &&
      state.proof?.attemptId === link.proofAttemptId &&
      state.proof.version === link.version &&
      state.proof.consumed
    );
  }

  private validProof(s: State, proof: CloseProofRef): boolean {
    return (
      !!s.proof &&
      !s.proof.consumed &&
      s.proof.attemptId === proof.attemptId &&
      s.proof.version === proof.version
    );
  }

  private attempt(e: EvidenceResult): Attempt<EvidenceKind> {
    return {
      accountId: e.accountId,
      instrumentUid: e.instrumentUid,
      stopId: e.stopId,
      version: e.version,
      attemptId: e.attemptId,
      kind: e.kind,
    };
  }
}

function orderIntent(order: OrderIntent): OrderIntent {
  const {
    id,
    accountId,
    instrumentUid,
    ticker,
    timeframe,
    context,
    direction,
    lots,
    fromPosition,
    targetPosition,
  } = order;
  return {
    id,
    accountId,
    instrumentUid,
    ticker,
    timeframe,
    context,
    direction,
    lots,
    fromPosition,
    targetPosition,
  };
}

function hasBlockingOrder(state: State): boolean {
  return !!state.entry || Object.values(state.orders).some((order) => isBlocking(state, order));
}

function resetStopEvidence(state: State): void {
  state.proof = null;
  state.definiteChildren = {};
  state.definiteParent = null;
  state.stopSubmitPending = false;
}

function isLinked(order: RecoveredOrder | undefined): order is LinkedOrder {
  return !!order?.protectionLink && order.orderVersion !== undefined;
}

function isBlocking(state: State, order: RecoveredOrder): boolean {
  return isLinked(order)
    ? !state.settledOrders[order.id]
    : order.status === 'reserved' || order.status === 'unconfirmed';
}

function sameLink(a: CloseLink, b: CloseLink): boolean {
  return (
    a.accountId === b.accountId &&
    a.instrumentUid === b.instrumentUid &&
    a.stopId === b.stopId &&
    a.version === b.version &&
    a.proofAttemptId === b.proofAttemptId &&
    a.orderId === b.orderId
  );
}

function observationsSafe(
  child: { terminal: boolean; executedLots: number | null } | undefined,
): boolean {
  return (
    !!child &&
    child.terminal &&
    child.executedLots !== null &&
    Number.isSafeInteger(child.executedLots) &&
    child.executedLots >= 0
  );
}

function usableChildId(id: string) {
  return !!id && !Object.hasOwn(Object.prototype, id);
}

function parentCannotFire(
  evidence: Extract<EvidenceResult, { kind: 'close' }>,
  protection: StoredProtection,
) {
  return (
    evidence.stopObservation?.status === 'cancelled' ||
    evidence.stopObservation?.status === 'absent' ||
    protection.state === 'not-sent' ||
    protection.state === 'rejected'
  );
}
