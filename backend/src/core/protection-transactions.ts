import type {
  OrderIntent,
  OrderResult,
  Protection,
  ProtectionCloseObservation,
  ProtectionObservation,
  RecoveredOrder,
} from './robot.js';

export type Selection = { accountId: string; instrumentUid: string };
export type StopKey = Selection & { stopId: string };
export type StopRef = StopKey & { version: number };
declare const stopSubmitOwnerBrand: unique symbol;
/** Ephemeral capability issued only to the caller of an acknowledged begin. */
export type StopSubmitOwner = StopRef & { readonly [stopSubmitOwnerBrand]: true };
export type EvidenceKind = 'lookup' | 'close';
export type Attempt<K extends EvidenceKind> = StopRef & { attemptId: string; kind: K };
export type ChildEvidence = {
  childId: string;
  terminal: boolean;
  executedLots: number | null;
};
export type EvidenceResult =
  | (Attempt<'lookup'> & { observation: ProtectionObservation })
  | (Attempt<'close'> & {
      parent: ProtectionCloseObservation;
      children: ChildEvidence[];
      /** Fresh lookup in this attempt; cached observations are not close authorization. */
      stopObservation?: ProtectionObservation;
    });
export type AccountEvidence = Selection & { position: number | null; activeOrders: boolean };
declare const closeProofBrand: unique symbol;
/** Issued only after a successful close-evidence write; the store still validates it. */
export type CloseProofRef = StopRef & { attemptId: string; readonly [closeProofBrand]: true };
export type CloseLink = StopRef & { proofAttemptId: string; orderId: string };
export type LinkedOrder = RecoveredOrder & {
  protectionLink: CloseLink;
  orderVersion: number;
  submitState: 'unclaimed' | 'claimed';
};
declare const closeReservationOwnerBrand: unique symbol;
declare const closeSubmitOwnerBrand: unique symbol;
export type CloseReservationOwner = { readonly [closeReservationOwnerBrand]: true };
export type CloseSubmitOwner = { readonly [closeSubmitOwnerBrand]: true };
export type CloseBeforeSendReason = 'stopped-before-send' | 'account-check-failed-before-send';
export type CloseSettlement = {
  kind: 'observed';
  result: OrderResult & { status: 'confirmed' | 'reconciled' | 'unconfirmed' };
  /** Required, with a matching flat account and no active orders, to clear protection. */
  account?: AccountEvidence;
};
export type Write<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'stale' | 'blocked' | 'order-conflict' };
export type ProtectionIntent = Pick<
  Protection,
  'id' | 'accountId' | 'instrumentUid' | 'direction' | 'lots' | 'stop'
>;
/** The trigger and broker request ID are fixed before the entry can be sent. */
export type StopPlan = { id: string; stop: number };
export type EntryRef = Selection & { orderId: string; version: number };
declare const entrySubmitOwnerBrand: unique symbol;
export type EntrySubmitOwner = EntryRef & { readonly [entrySubmitOwnerBrand]: true };
export type EntryBeforeSendStatus =
  | 'stopped-before-send'
  | 'feed-lost-before-send'
  | 'stale-signal-before-send'
  | 'account-check-failed-before-send'
  | 'session-check-failed-before-send'
  | 'session-ended-before-send';
export type GuardedEntry = {
  order: RecoveredOrder;
  ref: EntryRef;
  plan: StopPlan;
  submitStarted: boolean;
};
export type EntrySettlement =
  | { kind: 'not-sent'; origin: string; status?: EntryBeforeSendStatus }
  | {
      kind: 'observed';
      result: OrderResult & { status: 'confirmed' | 'reconciled' | 'unconfirmed' };
      account?: AccountEvidence;
      /** Explicit recovery of a terminal partial fill. */
      recoverPartial?: boolean;
    };
export type EntrySettlementValue = { order: RecoveredOrder; protection: StoredProtection | null };
export type StoredProtection = Protection & {
  entryOrderId?: string;
  version: number;
  pendingAttempt: Attempt<EvidenceKind> | null;
  completedAttempt: Attempt<EvidenceKind> | null;
};

/**
 * Atomic, durable transitions. A false result performs no write. A thrown error
 * can have committed, and never authorizes a broker side effect. Callers may
 * reload after either outcome only for read-only reconciliation.
 *
 * Implementations must serialize these transitions with ordinary order
 * reservations, and compare the complete scoped reference on every write.
 * Once an order has an observed outcome, pre-send settlements cannot release
 * it; reconcile the original order instead. A completed unconfirmed stop
 * submission is likewise immutable and must be reconciled by its original ID.
 * For guarded entries, retain verified fill counts and execution rows together
 * across incomplete observations; rows without a total establish at least a
 * fill lower bound and cannot be erased by a later zero-fill observation.
 * A reconciled terminal zero-fill close with matching unchanged position and no
 * active orders releases its guard, not its history; replacement requires new
 * evidence, only if no prior fill was observed. Ambiguous and partial closes
 * remain blocking; retain definite cumulative fills across incomplete results
 * and reject contradictory lower fills. Preserve definite parent and child
 * evidence and public lookup observations across incomplete observations, and
 * do not authorize a close when a
 * lookup reports an active child despite earlier terminal child evidence.
 * A stop-submit owner is issued only on an acknowledged begin and is neither
 * persisted nor recoverable. Only that caller may send once or finish. A
 * failed begin, stale finish, restart, timeout, absent lookup, or never-triggered
 * observation cannot fence a potentially live sender. An orphaned pending
 * submission therefore remains blocked; recovery performs read-only lookup.
 * Settlement must not overwrite later evidence, and any eventual close requires
 * fresh reconciliation after the sender has definitively exited.
 *
 * Close reservation and submit owners are ephemeral, identity-based capabilities,
 * never persisted or returned by loads. Reserve atomically consumes the proof
 * and creates an unclaimed linked order. Begin compares its complete link and
 * order version, claims it, and only an acknowledged success grants a submit
 * owner. Consume is synchronous and single-use; the caller must invoke the
 * broker synchronously immediately after a successful consume, without awaiting
 * or invoking callbacks. Cancellation invalidates its owner synchronously
 * before the write and never restores it on failure. Explicit forfeit compares
 * the complete link and version and only releases an unclaimed order. A claimed
 * orphan remains blocking after restart. Cancellation and forfeit retain order
 * history and replacement requires fresh proof and a fresh order ID.
 */
export interface ProtectionTransactions {
  reserveProtectedEntry(
    order: OrderIntent,
    plan: StopPlan,
    origin: string,
    replacing?: { proof: CloseProofRef; fallback: StopPlan },
  ): Promise<Write<GuardedEntry>>;
  loadProtectedEntry(): Promise<GuardedEntry | null>;
  beginEntrySubmit(
    expected: EntryRef,
    origin: string,
  ): Promise<Write<GuardedEntry & { owner: EntrySubmitOwner }>>;
  consumeEntrySubmit(owner: EntrySubmitOwner): boolean;
  cancelEntryBeforeSend(
    owner: EntrySubmitOwner,
    status: EntryBeforeSendStatus,
  ): Promise<Write<EntrySettlementValue>>;
  settleProtectedEntry(
    expected: EntryRef,
    settlement: EntrySettlement,
  ): Promise<Write<EntrySettlementValue>>;
  loadProtection(): Promise<StoredProtection | null>;
  reserveProtection(intent: ProtectionIntent): Promise<Write<StoredProtection>>;
  beginStopSubmit(
    expected: StopRef,
  ): Promise<Write<{ protection: StoredProtection; owner: StopSubmitOwner }>>;
  finishStopSubmit(
    owner: StopSubmitOwner,
    outcome: 'confirmed' | 'not-sent' | 'rejected' | 'unconfirmed',
  ): Promise<Write<StoredProtection>>;
  beginCancellation(expected: StopRef): Promise<Write<StoredProtection>>;
  beginEvidence<K extends EvidenceKind>(
    expected: StopRef,
    kind: K,
    attemptId: string,
  ): Promise<Write<Attempt<K>>>;
  finishEvidence(
    evidence: Extract<EvidenceResult, { kind: 'close' }>,
  ): Promise<Write<StoredProtection & { closeProof: CloseProofRef | null }>>;
  finishEvidence(
    evidence: Extract<EvidenceResult, { kind: 'lookup' }>,
  ): Promise<Write<StoredProtection>>;
  reserveProtectedClose(
    proof: CloseProofRef,
    order: OrderIntent,
    account: AccountEvidence,
  ): Promise<
    Write<{
      order: LinkedOrder;
      protection: StoredProtection;
      reservationOwner: CloseReservationOwner;
    }>
  >;
  loadProtectedClose(orderId: string): Promise<LinkedOrder | null>;
  beginProtectedCloseSubmit(
    owner: CloseReservationOwner,
  ): Promise<Write<{ order: LinkedOrder; submitOwner: CloseSubmitOwner }>>;
  consumeProtectedCloseSubmit(owner: CloseSubmitOwner): boolean;
  cancelProtectedCloseBeforeSend(
    owner: CloseReservationOwner | CloseSubmitOwner,
    reason: CloseBeforeSendReason,
  ): Promise<Write<LinkedOrder>>;
  forfeitUnclaimedProtectedClose(link: CloseLink, version: number): Promise<Write<LinkedOrder>>;
  settleProtectedClose(
    link: CloseLink,
    expectedOrderVersion: number,
    settlement: CloseSettlement,
  ): Promise<Write<LinkedOrder>>;
  clearChildFlat(proof: CloseProofRef, account: AccountEvidence): Promise<Write<StoredProtection>>;
  replaceProtection(
    proof: CloseProofRef,
    plan: StopPlan,
    account: AccountEvidence,
  ): Promise<Write<StoredProtection>>;
}
