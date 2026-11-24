import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AccountEvidence,
  Attempt,
  CloseProofRef,
  CloseSettlement,
  ProtectionTransactions,
} from './protection-transactions.js';
import type { OrderIntent } from './robot.js';
import {
  MemoryProtectionTransactions,
  ProtectionMemory,
} from './protection-transactions.test-support.js';

// These assignments must remain illegal even when the structural fields match.
function typeContract(
  transactions: ProtectionTransactions,
  lookup: Attempt<'lookup'>,
  pendingClose: Attempt<'close'>,
) {
  // @ts-expect-error Lookup evidence is not a completed close proof.
  const lookupProof: CloseProofRef = lookup;
  // @ts-expect-error A pending close attempt is not a completed close proof.
  const pendingProof: CloseProofRef = pendingClose;
  const preSend: CloseSettlement = {
    kind: 'observed',
    result: {
      // @ts-expect-error Pre-send statuses must use the distinct not-sent settlement.
      status: 'stopped-before-send',
      brokerOrderId: null,
      brokerStatus: 'unknown',
      executedLots: null,
      executions: [],
      position: null,
    },
  };
  return [transactions, lookupProof, pendingProof, preSend];
}

test('protection transaction type contract is checked by TypeScript', () => {
  assert.equal(typeof typeContract, 'function');
});

async function overloadContract(
  transactions: ProtectionTransactions,
  close: Attempt<'close'>,
  lookup: Attempt<'lookup'>,
  order: OrderIntent,
  account: AccountEvidence,
) {
  const closed = await transactions.finishEvidence({
    ...close,
    parent: { status: 'never-triggered' },
    children: [],
  });
  if (closed.ok) {
    const proof: CloseProofRef | null = closed.value.closeProof;
    if (proof) {
      await transactions.reserveProtectedClose(proof, order, account);
      await transactions.clearChildFlat(proof, account);
    }
  }
  const looked = await transactions.finishEvidence({
    ...lookup,
    observation: { status: 'cancelled' },
  });
  if (looked.ok) {
    // @ts-expect-error A lookup result has no close proof.
    const proof = looked.value.closeProof;
    // @ts-expect-error A lookup record cannot authorize a protected close.
    await transactions.reserveProtectedClose(looked.value, order, account);
    // @ts-expect-error A lookup record cannot authorize clearing protection.
    await transactions.clearChildFlat(looked.value, account);
    return proof;
  }
}

test('overload contract is checked by TypeScript', () =>
  assert.equal(typeof overloadContract, 'function'));

const intent = {
  id: 'stop',
  accountId: 'a',
  instrumentUid: 'i',
  direction: 'sell' as const,
  lots: 2,
  stop: 90,
};
const account = { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false };
const order: OrderIntent = {
  id: 'order',
  accountId: 'a',
  instrumentUid: 'i',
  ticker: 'T',
  timeframe: '1h',
  context: { type: 'manual-close', time: 1 },
  direction: 'sell',
  lots: 2,
  fromPosition: 2,
  targetPosition: 0,
};
function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected success');
  return result.value;
}
function ref(p: { id: string; accountId: string; instrumentUid: string; version: number }) {
  return {
    stopId: p.id,
    accountId: p.accountId,
    instrumentUid: p.instrumentUid,
    version: p.version,
  };
}

test('shared CAS, pending markers, wrong attempt and restart', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const initial = value(await a.reserveProtection(intent));
  const attempt = value(await a.beginEvidence(ref(initial), 'lookup', 'lookup-1'));
  assert.equal((await b.loadProtection())?.pendingAttempt?.attemptId, 'lookup-1');
  assert.deepEqual(await b.beginEvidence(ref(initial), 'close', 'other'), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(await b.beginEvidence(attempt, 'close', 'other'), {
    ok: false,
    reason: 'blocked',
  });
  assert.deepEqual(
    await b.finishEvidence({
      ...attempt,
      attemptId: 'wrong',
      observation: { status: 'cancelled' },
    }),
    { ok: false, reason: 'blocked' },
  );
  const looked = value(
    await b.finishEvidence({ ...attempt, observation: { status: 'cancelled' } }),
  );
  assert.equal(looked.completedAttempt?.kind, 'lookup');
  assert.equal(looked.pendingAttempt, null);
  assert.deepEqual(
    await a.reserveProtectedClose(attempt as unknown as CloseProofRef, order, account),
    { ok: false, reason: 'stale' },
  );
});

test('committed ambiguous stop submission cannot be reclassified or resent', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const initial = value(await store.reserveProtection(intent));
  const submitting = value(await store.beginStopSubmit(ref(initial)));
  const ambiguous = value(await store.finishStopSubmit(submitting.owner, 'unconfirmed'));
  const restarted = new MemoryProtectionTransactions(memory);
  assert.deepEqual(await restarted.finishStopSubmit(submitting.owner, 'not-sent'), {
    ok: false,
    reason: 'blocked',
  });
  assert.equal((await restarted.beginStopSubmit(ref(ambiguous))).ok, false);
  const lookup = value(await restarted.beginEvidence(ref(ambiguous), 'lookup', 'original-id'));
  const observed = value(
    await restarted.finishEvidence({ ...lookup, observation: { status: 'absent' } }),
  );
  assert.equal(observed.id, intent.id);
  assert.equal(observed.state, 'absent');
});

test('postcommit begin failure leaves an orphan blocked across negative lookups and restart', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const initial = value(await store.reserveProtection(intent));
  memory.failNext = 'postcommit';
  await assert.rejects(store.beginStopSubmit(ref(initial)));
  const restarted = new MemoryProtectionTransactions(memory);
  let p = (await restarted.loadProtection())!;
  assert.equal((await restarted.beginStopSubmit(ref(p))).ok, false);
  assert.equal((await restarted.beginCancellation(ref(p))).ok, false);
  const lookup = value(await restarted.beginEvidence(ref(p), 'lookup', 'negative'));
  p = value(await restarted.finishEvidence({ ...lookup, observation: { status: 'absent' } }));
  assert.equal(p.state, 'unconfirmed');
  assert.equal((await restarted.beginCancellation(ref(p))).ok, false);
  const close = value(await restarted.beginEvidence(ref(p), 'close', 'close'));
  const result = value(
    await restarted.finishEvidence({
      ...close,
      parent: { status: 'never-triggered' },
      children: [],
      stopObservation: { status: 'absent' },
    }),
  );
  assert.equal(result.closeProof, null);
  assert.equal((await restarted.beginStopSubmit(ref(result))).ok, false);
});

test('negative lookup cannot revoke a paused sender or authorize a conflicting close', async () => {
  const memory = new ProtectionMemory();
  const sender = new MemoryProtectionTransactions(memory);
  const recovery = new MemoryProtectionTransactions(memory);
  const initial = value(await sender.reserveProtection(intent));
  const begun = value(await sender.beginStopSubmit(ref(initial)));
  assert.equal((await recovery.beginCancellation(ref(begun.protection))).ok, false);
  const lookup = value(await recovery.beginEvidence(ref(begun.protection), 'lookup', 'negative'));
  const observed = value(
    await recovery.finishEvidence({ ...lookup, observation: { status: 'absent' } }),
  );
  assert.equal((await recovery.beginCancellation(ref(observed))).ok, false);
  const close = value(await recovery.beginEvidence(ref(observed), 'close', 'close'));
  const result = value(
    await recovery.finishEvidence({
      ...close,
      parent: { status: 'never-triggered' },
      children: [],
      stopObservation: { status: 'absent' },
    }),
  );
  assert.equal(result.closeProof, null);
  // The original sender may still execute its already-authorized RPC.
  let submissions = 0;
  submissions++;
  assert.equal((await sender.finishStopSubmit(begun.owner, 'unconfirmed')).ok, false);
  assert.equal((await recovery.beginStopSubmit(ref(result))).ok, false);
  assert.equal(submissions, 1);
});

test('lost in-flight reply remains blocked after a negative lookup', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const initial = value(await store.reserveProtection(intent));
  const begun = value(await store.beginStopSubmit(ref(initial)));
  let submissions = 0;
  const rpc = async () => {
    submissions++;
    throw new Error('reply lost');
  };
  await assert.rejects(rpc());
  const lookup = value(await store.beginEvidence(ref(begun.protection), 'lookup', 'negative'));
  const observed = value(
    await store.finishEvidence({ ...lookup, observation: { status: 'absent' } }),
  );
  assert.equal((await store.finishStopSubmit(begun.owner, 'unconfirmed')).ok, false);
  const close = value(await store.beginEvidence(ref(observed), 'close', 'close'));
  const result = value(
    await store.finishEvidence({
      ...close,
      parent: { status: 'never-triggered' },
      children: [],
      stopObservation: { status: 'absent' },
    }),
  );
  assert.equal(result.closeProof, null);
  assert.equal((await store.beginStopSubmit(ref(result))).ok, false);
  assert.equal(submissions, 1);
});

test('unknown parent evidence cannot erase a definite never-triggered observation', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  let p = value(await store.reserveProtection(intent));
  const first = value(await store.beginEvidence(ref(p), 'close', 'first'));
  p = value(
    await store.finishEvidence({ ...first, parent: { status: 'never-triggered' }, children: [] }),
  );
  const next = value(await store.beginEvidence(ref(p), 'close', 'unknown'));
  p = value(await store.finishEvidence({ ...next, parent: { status: 'unknown' }, children: [] }));
  const last = value(await store.beginEvidence(ref(p), 'close', 'triggered'));
  const result = value(
    await store.finishEvidence({
      ...last,
      parent: { status: 'triggered', childIds: ['child'] },
      children: [{ childId: 'child', terminal: true, executedLots: 0 }],
    }),
  );
  assert.equal(result.evidenceConflict, true);
  assert.equal(result.closeProof, null);
});

test('evidence union, contradictions and failure atomicity', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const initial = value(await store.reserveProtection(intent));
  memory.failNext = 'precommit';
  await assert.rejects(store.beginEvidence(ref(initial), 'close', 'c1'));
  assert.equal((await store.loadProtection())?.pendingAttempt, null);
  memory.failNext = 'postcommit';
  await assert.rejects(store.beginEvidence(ref(initial), 'close', 'c1'));
  const pending = (await store.loadProtection())!.pendingAttempt as Attempt<'close'>;
  const first = value(
    await store.finishEvidence({
      ...pending,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [{ childId: 'x', terminal: true, executedLots: 1 }],
    }),
  );
  assert.ok(first.closeProof);
  const next = value(await store.beginEvidence(ref(first), 'close', 'c2'));
  const second = value(
    await store.finishEvidence({
      ...next,
      parent: { status: 'triggered', childIds: ['y'] },
      children: [
        { childId: 'y', terminal: true, executedLots: 0 },
        { childId: 'x', terminal: false, executedLots: 2 },
      ],
    }),
  );
  assert.deepEqual(second.childIds, ['x', 'y']);
  assert.equal(second.evidenceConflict, true);
  assert.equal(second.closeProof, null);
});

const closeExecutions = [{ tradeId: 'close-fill', lots: 2, price: 100, time: 1 }];

test('linked close enforces exact account delta, consumes proof and settles conservatively', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const initial = value(await a.reserveProtection(intent));
  const attempt = value(await a.beginEvidence(ref(initial), 'close', 'c'));
  const completed = value(
    await a.finishEvidence({ ...attempt, parent: { status: 'never-triggered' }, children: [] }),
  );
  const proof = completed.closeProof!;
  assert.ok(proof);
  assert.equal((await a.reserveProtectedClose(proof, { ...order, lots: 3 }, account)).ok, false);
  const reservation = value(await a.reserveProtectedClose(proof, order, account));
  const linked = reservation.order;
  assert.equal(
    (await b.reserveProtectedClose(proof, { ...order, id: 'other' }, account)).ok,
    false,
  );
  assert.equal((await b.clearChildFlat(proof, { ...account, position: 0 })).ok, false);
  assert.deepEqual(await b.loadProtectedClose(order.id), linked);
  assert.equal((await b.forfeitUnclaimedProtectedClose(linked.protectionLink, 0)).ok, false);
  const begun = value(await a.beginProtectedCloseSubmit(reservation.reservationOwner));
  assert.equal(a.consumeProtectedCloseSubmit(begun.submitOwner), true);
  const settled = value(
    await b.settleProtectedClose(linked.protectionLink, begun.order.orderVersion, {
      kind: 'observed',
      result: {
        status: 'unconfirmed',
        brokerStatus: 'unknown',
        brokerOrderId: null,
        executedLots: null,
        executions: [],
        position: null,
      },
      account: { ...account, position: 0 },
    }),
  );
  assert.ok(await b.loadProtection());
  value(
    await b.settleProtectedClose(linked.protectionLink, settled.orderVersion, {
      kind: 'observed',
      result: {
        status: 'confirmed',
        brokerStatus: 'filled',
        brokerOrderId: 'b',
        executedLots: 2,
        executions: closeExecutions,
        position: 0,
      },
      account: { ...account, position: 0 },
    }),
  );
  assert.equal(await a.loadProtection(), null);
});

// Contract fake only: Robot does not yet use this port.
test('active lookup followed by never-triggered close cannot issue proof', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const p = value(await store.reserveProtection(intent));
  const l = value(await store.beginEvidence(ref(p), 'lookup', 'l'));
  const active = value(await store.finishEvidence({ ...l, observation: { status: 'active' } }));
  const c = value(await store.beginEvidence(ref(active), 'close', 'c'));
  assert.equal(
    value(await store.finishEvidence({ ...c, parent: { status: 'never-triggered' }, children: [] }))
      .closeProof,
    null,
  );
});

test('active lookup of a previously terminal child poisons omitted-child close evidence', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const p = value(await store.reserveProtection(intent));
  const first = value(await store.beginEvidence(ref(p), 'close', 'first'));
  const terminal = value(
    await store.finishEvidence({
      ...first,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [{ childId: 'x', terminal: true, executedLots: 0 }],
    }),
  );
  assert.ok(terminal.closeProof);
  const lookup = value(await store.beginEvidence(ref(terminal), 'lookup', 'lookup'));
  const active = value(
    await store.finishEvidence({
      ...lookup,
      observation: { status: 'triggered', childId: 'x', childStatus: 'active' },
    }),
  );
  assert.equal(active.evidenceConflict, true);
  const close = value(await store.beginEvidence(ref(active), 'close', 'close'));
  const result = value(
    await store.finishEvidence({
      ...close,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [],
    }),
  );
  assert.equal(result.closeProof, null);
  assert.equal((await store.reserveProtectedClose(terminal.closeProof, order, account)).ok, false);
});

test('a previously terminal child still needs a fresh execution total for a new proof', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const p = value(await store.reserveProtection(intent));
  const first = value(await store.beginEvidence(ref(p), 'close', 'first'));
  const terminal = value(
    await store.finishEvidence({
      ...first,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [{ childId: 'x', terminal: true, executedLots: 1 }],
    }),
  );
  assert.ok(terminal.closeProof);
  const next = value(await store.beginEvidence(ref(terminal), 'close', 'next'));
  const omitted = value(
    await store.finishEvidence({
      ...next,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [],
    }),
  );
  assert.equal(omitted.closeProof, null);
  assert.deepEqual(omitted.childObservations?.x, { terminal: true, executedLots: 1 });
});

test('terminal child requires definite lots; nonterminal fills can progress', async () => {
  for (const lots of [null, 1]) {
    const store = new MemoryProtectionTransactions(new ProtectionMemory());
    const p = value(await store.reserveProtection(intent));
    const c = value(await store.beginEvidence(ref(p), 'close', 'c1'));
    const first = value(
      await store.finishEvidence({
        ...c,
        parent: { status: 'triggered', childIds: ['x'] },
        children: [{ childId: 'x', terminal: false, executedLots: 0 }],
      }),
    );
    assert.equal(first.closeProof, null);
    const next = value(await store.beginEvidence(ref(first), 'close', 'c2'));
    const done = value(
      await store.finishEvidence({
        ...next,
        parent: { status: 'triggered', childIds: ['x'] },
        children: [{ childId: 'x', terminal: true, executedLots: lots }],
      }),
    );
    assert.equal(done.childObservations?.x.executedLots, lots);
    assert.equal(done.evidenceConflict, undefined);
    assert.equal(!!done.closeProof, lots === 1);
  }
});

test('incomplete terminal evidence cannot erase a previously definite child fill', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  let p = value(await store.reserveProtection(intent));
  for (const [index, lots] of [2, null, 1].entries()) {
    const c = value(await store.beginEvidence(ref(p), 'close', `child-${index}`));
    const done = value(
      await store.finishEvidence({
        ...c,
        parent: { status: 'triggered', childIds: ['x'] },
        children: [{ childId: 'x', terminal: true, executedLots: lots }],
      }),
    );
    if (index === 1) assert.equal(done.closeProof, null);
    if (index === 2) {
      assert.equal(done.evidenceConflict, true);
      assert.equal(done.closeProof, null);
    }
    p = done;
  }
});

async function ready() {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const p = value(await store.reserveProtection(intent));
  const c = value(await store.beginEvidence(ref(p), 'close', 'proof'));
  const done = value(
    await store.finishEvidence({ ...c, parent: { status: 'never-triggered' }, children: [] }),
  );
  assert.ok(done.closeProof);
  return { memory, store, proof: done.closeProof };
}

test('ordinary and protection reservations share a single slot across instances', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  assert.equal(await a.reserve(order), true);
  assert.equal(await b.hasUnresolved(), true);
  assert.equal((await b.unresolved())?.id, order.id);
  assert.equal((await b.reserveProtection(intent)).ok, false);
  await b.record(order.id, {
    status: 'stopped-before-send',
    brokerOrderId: null,
    brokerStatus: 'unknown',
    executedLots: null,
    executions: [],
    position: null,
  });
  assert.equal(await a.hasUnresolved(), false);
  assert.equal((await b.reserveProtection(intent)).ok, true);
  assert.equal(await a.reserve({ ...order, id: 'other' }), false);
});

test('historical ordinary orders can become unconfirmed only when the shared slot is free', async () => {
  for (const occupant of ['none', 'order', 'protection'] as const) {
    const memory = new ProtectionMemory();
    const a = new MemoryProtectionTransactions(memory);
    const b = new MemoryProtectionTransactions(memory);
    const result = {
      status: 'reconciled' as const,
      brokerOrderId: 'b',
      brokerStatus: 'filled' as const,
      executedLots: 2,
      executions: [],
      position: 0,
    };
    assert.equal(await a.reserve(order), true);
    await a.record(order.id, result);
    if (occupant === 'order') assert.equal(await b.reserve({ ...order, id: 'other' }), true);
    if (occupant === 'protection') assert.equal((await b.reserveProtection(intent)).ok, true);
    const update = { ...result, status: 'unconfirmed' as const };
    if (occupant === 'none') {
      await b.record(order.id, update);
      assert.equal((await a.unresolved())?.id, order.id);
      assert.equal(await a.reserve({ ...order, id: 'other' }), false);
    } else {
      await assert.rejects(b.record(order.id, update));
      assert.equal((await a.history())[0]?.status, 'reconciled');
      assert.equal((await a.unresolved())?.id ?? null, occupant === 'order' ? 'other' : null);
      assert.equal(await a.hasUnresolved(), occupant === 'order');
    }
  }
});

test('ordinary writes project fields and detach nested inputs from the journal', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const link = {
    accountId: 'a',
    instrumentUid: 'i',
    stopId: 'forged',
    version: 1,
    proofAttemptId: 'forged',
    orderId: order.id,
  };
  const context = {
    type: 'signal' as const,
    candleTime: 1,
    signalTime: 2,
    strategy: { kind: 'surfing', nested: { value: 1 } },
  };
  const injected = { ...order, context, protectionLink: link, orderVersion: 1 };
  assert.equal(await a.reserve(injected), true);
  context.strategy.nested.value = 99;
  const executions = [{ tradeId: 't', lots: 1, price: 100, time: 1 }];
  const result = {
    status: 'unconfirmed' as const,
    brokerOrderId: 'b',
    brokerStatus: 'partial' as const,
    executedLots: 1,
    executions,
    position: 1,
    protectionLink: link,
    orderVersion: 9,
    accountId: 'evil',
  };
  await b.record(order.id, result);
  executions[0]!.lots = 99;
  link.stopId = 'mutated';
  const saved = (await a.unresolved())!;
  assert.equal(saved.protectionLink, undefined);
  assert.equal(saved.orderVersion, undefined);
  assert.equal(saved.accountId, 'a');
  assert.equal(saved.executions[0]?.lots, 1);
  assert.deepEqual(saved.context, {
    type: 'signal',
    candleTime: 1,
    signalTime: 2,
    strategy: { kind: 'surfing', nested: { value: 1 } },
  });
  assert.equal(await b.loadProtectedClose(order.id), null);
});

test('linked journal remains visible and protected from ordinary record across restart', async () => {
  const { memory, store, proof } = await ready();
  const reservation = value(await store.reserveProtectedClose(proof, order, account));
  const begun = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner));
  assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), true);
  const restarted = new MemoryProtectionTransactions(memory);
  const linked = (await restarted.loadProtectedClose(order.id))!;
  assert.deepEqual(await restarted.unresolved(), linked);
  assert.equal(await restarted.hasUnresolved(), true);
  const result = {
    status: 'reconciled' as const,
    brokerStatus: 'partial' as const,
    brokerOrderId: 'b',
    executedLots: 1,
    executions: [],
    position: 1,
  };
  await assert.rejects(restarted.record(order.id, result));
  assert.deepEqual(await restarted.loadProtectedClose(order.id), linked);
  memory.failNext = 'postcommit';
  await assert.rejects(
    restarted.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
      kind: 'observed',
      result,
    }),
  );
  const again = new MemoryProtectionTransactions(memory);
  const partial = (await again.loadProtectedClose(order.id))!;
  assert.equal(partial.orderVersion, 3);
  assert.deepEqual(await again.unresolved(), partial);
  assert.equal(await again.hasUnresolved(), true);
  assert.equal(await again.reserve({ ...order, id: 'other' }), false);
  await assert.rejects(again.record(order.id, result));
  assert.deepEqual(await again.loadProtectedClose(order.id), partial);
  value(
    await again.settleProtectedClose(partial.protectionLink, partial.orderVersion, {
      kind: 'observed',
      result: {
        ...result,
        status: 'confirmed',
        brokerStatus: 'filled',
        executedLots: 2,
        executions: closeExecutions,
        position: 0,
      },
      account: { ...account, position: 0 },
    }),
  );
  const settled = await again.loadProtectedClose(order.id);
  assert.equal(await again.hasUnresolved(), false);
  await assert.rejects(again.record(order.id, result));
  assert.deepEqual(await again.loadProtectedClose(order.id), settled);
  assert.equal((await again.history()).length, 1);
});

test('same-version forged proof cannot consume valid proof', async () => {
  const { store, proof } = await ready();
  assert.deepEqual(
    await store.reserveProtectedClose({ ...proof, attemptId: 'forged' }, order, account),
    { ok: false, reason: 'blocked' },
  );
  assert.ok((await store.reserveProtectedClose(proof, order, account)).ok);
});

test('child fills and flat account clear protection once', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const p = value(await store.reserveProtection(intent));
  const c = value(await store.beginEvidence(ref(p), 'close', 'child'));
  const done = value(
    await store.finishEvidence({
      ...c,
      parent: { status: 'triggered', childIds: ['x'] },
      children: [{ childId: 'x', terminal: true, executedLots: 2 }],
    }),
  );
  assert.ok(done.closeProof);
  value(await store.clearChildFlat(done.closeProof, { ...account, position: 0 }));
  assert.equal(await store.loadProtection(), null);
  assert.equal(
    (await store.clearChildFlat(done.closeProof, { ...account, position: 0 })).ok,
    false,
  );
});

test('settlement uses only result fields and structural link; history permits next cycle', async () => {
  const { store, proof } = await ready();
  const reservation = value(await store.reserveProtectedClose(proof, order, account));
  const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
  const l = linked.protectionLink;
  const reordered = {
    orderId: l.orderId,
    proofAttemptId: l.proofAttemptId,
    version: l.version,
    stopId: l.stopId,
    instrumentUid: l.instrumentUid,
    accountId: l.accountId,
  };
  const result = {
    status: 'confirmed' as const,
    brokerOrderId: 'b',
    brokerStatus: 'filled' as const,
    executedLots: 2,
    executions: closeExecutions,
    position: 0,
    lots: 100,
    accountId: 'evil',
    protectionLink: { ...l, stopId: 'evil' },
  };
  const settled = value(
    await store.settleProtectedClose(reordered, linked.orderVersion, {
      kind: 'observed',
      result,
      account: { ...account, position: 0 },
    }),
  );
  assert.equal(settled.lots, 2);
  assert.equal(settled.accountId, 'a');
  assert.deepEqual(settled.protectionLink, l);
  assert.equal(await store.loadProtection(), null);
  const next = value(await store.reserveProtection({ ...intent, id: 'stop-2' }));
  const c = value(await store.beginEvidence(ref(next), 'close', 'next'));
  const done = value(
    await store.finishEvidence({ ...c, parent: { status: 'never-triggered' }, children: [] }),
  );
  assert.ok(done.closeProof);
  assert.equal((await store.forfeitUnclaimedProtectedClose(l, settled.orderVersion)).ok, false);
  assert.ok(
    (await store.reserveProtectedClose(done.closeProof, { ...order, id: 'order-2' }, account)).ok,
  );
});

test('not-sent history allows fresh evidence and new linked close', async () => {
  const { store, proof } = await ready();
  const linked = value(await store.reserveProtectedClose(proof, order, account));
  value(await store.cancelProtectedCloseBeforeSend(linked.reservationOwner, 'stopped-before-send'));
  const p = (await store.loadProtection())!;
  const c = value(await store.beginEvidence(ref(p), 'close', 'fresh'));
  const done = value(
    await store.finishEvidence({ ...c, parent: { status: 'never-triggered' }, children: [] }),
  );
  assert.ok(done.closeProof);
  assert.ok(
    (await store.reserveProtectedClose(done.closeProof, { ...order, id: 'new' }, account)).ok,
  );
});

test('a claimed close with a full lot count but no execution rows remains blocking', async () => {
  const { store, proof } = await ready();
  const reserved = value(await store.reserveProtectedClose(proof, order, account));
  const claim = value(await store.beginProtectedCloseSubmit(reserved.reservationOwner));
  assert.equal(store.consumeProtectedCloseSubmit(claim.submitOwner), true);
  const observed = value(
    await store.settleProtectedClose(claim.order.protectionLink, claim.order.orderVersion, {
      kind: 'observed',
      result: {
        status: 'confirmed',
        brokerStatus: 'filled',
        brokerOrderId: 'b',
        executedLots: 2,
        executions: [],
        position: 0,
      },
      account: { ...account, position: 0 },
    }),
  );
  assert.equal(observed.status, 'unconfirmed');
  assert.equal((await store.unresolved())?.id, order.id);
  assert.ok(await store.loadProtection());
});

test('reconciled terminal zero-fill close releases guard only for fresh evidence', async () => {
  for (const brokerStatus of ['rejected', 'cancelled'] as const) {
    const { store, proof } = await ready();
    const reservation = value(await store.reserveProtectedClose(proof, order, account));
    const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
    const settled = value(
      await store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
        kind: 'observed',
        result: {
          status: 'reconciled',
          brokerStatus,
          brokerOrderId: 'b',
          executedLots: 0,
          executions: [],
          position: 2,
        },
        account,
      }),
    );
    assert.deepEqual(await store.loadProtectedClose(order.id), settled);
    assert.equal(
      (await store.reserveProtectedClose(proof, { ...order, id: 'replacement' }, account)).ok,
      false,
    );
    assert.equal(
      (await store.forfeitUnclaimedProtectedClose(linked.protectionLink, settled.orderVersion)).ok,
      false,
    );
    const p = (await store.loadProtection())!;
    const c = value(await store.beginEvidence(ref(p), 'close', 'fresh'));
    const done = value(
      await store.finishEvidence({ ...c, parent: { status: 'never-triggered' }, children: [] }),
    );
    assert.ok(done.closeProof);
    assert.ok(
      (await store.reserveProtectedClose(done.closeProof, { ...order, id: 'replacement' }, account))
        .ok,
    );
  }
});

test('ambiguous and partial linked closes continue blocking fresh evidence', async () => {
  for (const [status, brokerStatus, executedLots, position] of [
    ['unconfirmed', 'unknown', null, null],
    ['reconciled', 'partial', 1, 1],
    ['reconciled', 'cancelled', 1, 1],
  ] as const) {
    const { store, proof } = await ready();
    const reservation = value(await store.reserveProtectedClose(proof, order, account));
    const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
    value(
      await store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
        kind: 'observed',
        result: {
          status,
          brokerStatus,
          brokerOrderId: 'b',
          executedLots,
          executions: [],
          position,
        },
        account: { ...account, position },
      }),
    );
    const p = (await store.loadProtection())!;
    assert.equal((await store.beginEvidence(ref(p), 'close', 'fresh')).ok, false);
  }
});

test('later zero-fill reconciliation cannot erase a previously observed partial close', async () => {
  const { store, proof } = await ready();
  const reservation = value(await store.reserveProtectedClose(proof, order, account));
  const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
  const executions = [{ tradeId: 'partial', lots: 1, price: 100, time: 1 }];
  const partial = value(
    await store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
      kind: 'observed',
      result: {
        status: 'reconciled',
        brokerStatus: 'partial',
        brokerOrderId: 'b',
        executedLots: 1,
        executions,
        position: 1,
      },
      account: { ...account, position: 1 },
    }),
  );
  const incomplete = value(
    await store.settleProtectedClose(linked.protectionLink, partial.orderVersion, {
      kind: 'observed',
      result: {
        status: 'unconfirmed',
        brokerStatus: 'unknown',
        brokerOrderId: 'b',
        executedLots: null,
        executions: [],
        position: null,
      },
    }),
  );
  assert.equal(incomplete.executedLots, 1);
  assert.deepEqual(incomplete.executions, executions);
  assert.deepEqual(
    await store.settleProtectedClose(linked.protectionLink, incomplete.orderVersion, {
      kind: 'observed',
      result: {
        status: 'reconciled',
        brokerStatus: 'cancelled',
        brokerOrderId: 'b',
        executedLots: 0,
        executions: [],
        position: 2,
      },
      account,
    }),
    { ok: false, reason: 'blocked' },
  );
  assert.equal((await store.loadProtectedClose(order.id))?.executedLots, 1);
  const p = (await store.loadProtection())!;
  assert.equal((await store.beginEvidence(ref(p), 'close', 'fresh')).ok, false);
  assert.equal(
    (await store.reserveProtectedClose(proof, { ...order, id: 'new' }, account)).ok,
    false,
  );
});

test('invalid fill observations cannot erase a partial close or release its guard', async () => {
  const { store, proof } = await ready();
  const reservation = value(await store.reserveProtectedClose(proof, order, account));
  const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
  const partial = value(
    await store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
      kind: 'observed',
      result: {
        status: 'reconciled',
        brokerStatus: 'partial',
        brokerOrderId: 'b',
        executedLots: 1,
        executions: [{ tradeId: 'partial', lots: 1, price: 100, time: 1 }],
        position: 1,
      },
    }),
  );
  const protection = await store.loadProtection();
  for (const executedLots of [NaN, Infinity, -1, 0.5, order.lots + 1]) {
    assert.deepEqual(
      await store.settleProtectedClose(linked.protectionLink, partial.orderVersion, {
        kind: 'observed',
        result: {
          status: 'reconciled',
          brokerStatus: 'cancelled',
          brokerOrderId: 'other',
          executedLots,
          executions: [],
          position: 2,
        },
        account,
      }),
      { ok: false, reason: 'blocked' },
    );
    assert.deepEqual(await store.loadProtectedClose(order.id), partial);
    assert.deepEqual(await store.loadProtection(), protection);
  }
  assert.deepEqual(
    await store.settleProtectedClose(linked.protectionLink, partial.orderVersion, {
      kind: 'observed',
      result: {
        status: 'reconciled',
        brokerStatus: 'cancelled',
        brokerOrderId: 'b',
        executedLots: 0,
        executions: [],
        position: 2,
      },
      account,
    }),
    { ok: false, reason: 'blocked' },
  );
  assert.deepEqual(await store.loadProtectedClose(order.id), partial);
  assert.equal((await store.beginEvidence(ref(protection!), 'close', 'fresh')).ok, false);
  assert.equal(
    (await store.reserveProtectedClose(proof, { ...order, id: 'new' }, account)).ok,
    false,
  );
});

test('observed ambiguous close cannot become pre-send and blocks until original order reconciles', async () => {
  for (const kind of ['not-sent', 'account-check-failed-before-send'] as const) {
    const { store, proof } = await ready();
    const reservation = value(await store.reserveProtectedClose(proof, order, account));
    const begun = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner));
    const linked = begun.order;
    assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), true);
    const observed = value(
      await store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
        kind: 'observed',
        result: {
          status: 'unconfirmed',
          brokerStatus: 'unknown',
          brokerOrderId: null,
          executedLots: null,
          executions: [],
          position: null,
        },
      }),
    );
    const before = await store.loadProtection();
    assert.deepEqual(
      await store.cancelProtectedCloseBeforeSend(
        begun.submitOwner,
        kind === 'not-sent' ? 'stopped-before-send' : kind,
      ),
      { ok: false, reason: 'blocked' },
    );
    assert.deepEqual(await store.loadProtectedClose(order.id), observed);
    assert.deepEqual(await store.loadProtection(), before);
    assert.equal((await store.beginEvidence(ref(before!), 'close', 'fresh')).ok, false);
    assert.equal(
      (await store.reserveProtectedClose(proof, { ...order, id: 'other' }, account)).ok,
      false,
    );
    value(
      await store.settleProtectedClose(linked.protectionLink, observed.orderVersion, {
        kind: 'observed',
        result: {
          status: 'reconciled',
          brokerStatus: 'filled',
          brokerOrderId: 'b',
          executedLots: 2,
          executions: closeExecutions,
          position: 0,
        },
        account: { ...account, position: 0 },
      }),
    );
    assert.equal(await store.loadProtection(), null);
  }
});

test('wrong link at active order version changes neither order nor protection', async () => {
  const { store, proof } = await ready();
  const linked = value(await store.reserveProtectedClose(proof, order, account)).order;
  const before = await store.loadProtection();
  assert.deepEqual(
    await store.forfeitUnclaimedProtectedClose(
      { ...linked.protectionLink, stopId: 'wrong' },
      linked.orderVersion,
    ),
    { ok: false, reason: 'stale' },
  );
  assert.deepEqual(await store.loadProtectedClose(order.id), linked);
  assert.deepEqual(await store.loadProtection(), before);
});

test('reserve and settlement fault injection reloads both records atomically', async () => {
  for (const failure of ['precommit', 'postcommit'] as const) {
    const { memory, store, proof } = await ready();
    const before = await store.loadProtection();
    assert.equal(store.proofSnapshot()?.consumed, false);
    memory.failNext = failure;
    await assert.rejects(store.reserveProtectedClose(proof, order, account));
    const reload = new MemoryProtectionTransactions(memory);
    assert.deepEqual(await reload.loadProtection(), before);
    assert.equal(reload.proofSnapshot()?.consumed, failure === 'postcommit');
    assert.equal(!!(await reload.loadProtectedClose(order.id)), failure === 'postcommit');
    assert.equal(
      (await reload.reserveProtectedClose(proof, { ...order, id: 'other' }, account)).ok,
      failure === 'precommit',
    );
  }
  for (const failure of ['precommit', 'postcommit'] as const) {
    const { memory, store, proof } = await ready();
    const reservation = value(await store.reserveProtectedClose(proof, order, account));
    const linked = value(await store.beginProtectedCloseSubmit(reservation.reservationOwner)).order;
    const before = await store.loadProtection();
    assert.equal(store.proofSnapshot()?.consumed, true);
    memory.failNext = failure;
    await assert.rejects(
      store.settleProtectedClose(linked.protectionLink, linked.orderVersion, {
        kind: 'observed',
        result: {
          status: 'confirmed',
          brokerStatus: 'filled',
          brokerOrderId: 'b',
          executedLots: 2,
          executions: closeExecutions,
          position: 0,
        },
        account: { ...account, position: 0 },
      }),
    );
    const reload = new MemoryProtectionTransactions(memory);
    const saved = await reload.loadProtectedClose(order.id);
    assert.equal(saved?.orderVersion, failure === 'precommit' ? 2 : 3);
    assert.equal(saved?.status, failure === 'precommit' ? 'reserved' : 'confirmed');
    assert.deepEqual(await reload.loadProtection(), failure === 'precommit' ? before : null);
    assert.equal(reload.proofSnapshot()?.consumed, true);
  }
});

test('close owners are opaque, single use, and never recovered by another instance', async () => {
  const { memory, store, proof } = await ready();
  const reserved = value(await store.reserveProtectedClose(proof, order, account));
  const restarted = new MemoryProtectionTransactions(memory);
  assert.deepEqual(await restarted.loadProtectedClose(order.id), reserved.order);
  assert.equal((await restarted.beginProtectedCloseSubmit(reserved.reservationOwner)).ok, false);
  assert.equal((await store.beginProtectedCloseSubmit({ ...reserved.reservationOwner })).ok, false);
  const begun = value(await store.beginProtectedCloseSubmit(reserved.reservationOwner));
  assert.equal((await store.beginProtectedCloseSubmit(reserved.reservationOwner)).ok, false);
  assert.equal(restarted.consumeProtectedCloseSubmit(begun.submitOwner), false);
  assert.equal(store.consumeProtectedCloseSubmit({ ...begun.submitOwner }), false);
  assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), true);
  assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), false);
  assert.equal((await restarted.loadProtectedClose(order.id))?.submitState, 'claimed');
  assert.equal(
    (
      await restarted.forfeitUnclaimedProtectedClose(
        begun.order.protectionLink,
        begun.order.orderVersion,
      )
    ).ok,
    false,
  );
  assert.equal(await restarted.hasUnresolved(), true);
});

test('forfeit races reservation and begin; consume races cancellation', async () => {
  for (const forfeitFirst of [true, false]) {
    const { memory, store, proof } = await ready();
    const other = new MemoryProtectionTransactions(memory);
    const reserved = value(await store.reserveProtectedClose(proof, order, account));
    const forfeit = () =>
      other.forfeitUnclaimedProtectedClose(
        reserved.order.protectionLink,
        reserved.order.orderVersion,
      );
    const begin = () => store.beginProtectedCloseSubmit(reserved.reservationOwner);
    const [first, second] = forfeitFirst
      ? [await forfeit(), await begin()]
      : [await begin(), await forfeit()];
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (forfeitFirst) {
      assert.equal(await other.hasUnresolved(), false);
      assert.equal((await other.history()).length, 1);
      assert.equal((await other.reserveProtectedClose(proof, order, account)).ok, false);
    } else {
      assert.equal(await other.hasUnresolved(), true);
    }
  }
  for (const cancelFirst of [true, false]) {
    const { store, proof } = await ready();
    const reserved = value(await store.reserveProtectedClose(proof, order, account));
    const begun = value(await store.beginProtectedCloseSubmit(reserved.reservationOwner));
    if (cancelFirst) {
      const cancellation = store.cancelProtectedCloseBeforeSend(
        begun.submitOwner,
        'stopped-before-send',
      );
      assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), false);
      assert.equal((await cancellation).ok, true);
    } else {
      assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), true);
      assert.equal(
        (await store.cancelProtectedCloseBeforeSend(begun.submitOwner, 'stopped-before-send')).ok,
        false,
      );
    }
  }
});

test('close owner transitions fail closed across precommit and postcommit errors', async () => {
  for (const failure of ['precommit', 'postcommit'] as const) {
    const { memory, store, proof } = await ready();
    const reserved = value(await store.reserveProtectedClose(proof, order, account));
    memory.failNext = failure;
    await assert.rejects(store.beginProtectedCloseSubmit(reserved.reservationOwner));
    assert.equal((await store.beginProtectedCloseSubmit(reserved.reservationOwner)).ok, false);
    const reloaded = new MemoryProtectionTransactions(memory);
    const saved = (await reloaded.loadProtectedClose(order.id))!;
    assert.equal(saved.submitState, failure === 'precommit' ? 'unclaimed' : 'claimed');
    assert.equal(await reloaded.hasUnresolved(), true);
    assert.equal(
      (await reloaded.forfeitUnclaimedProtectedClose(saved.protectionLink, saved.orderVersion)).ok,
      failure === 'precommit',
    );
  }
  for (const failure of ['precommit', 'postcommit'] as const) {
    const { memory, store, proof } = await ready();
    const reserved = value(await store.reserveProtectedClose(proof, order, account));
    const begun = value(await store.beginProtectedCloseSubmit(reserved.reservationOwner));
    memory.failNext = failure;
    await assert.rejects(
      store.cancelProtectedCloseBeforeSend(begun.submitOwner, 'stopped-before-send'),
    );
    assert.equal(store.consumeProtectedCloseSubmit(begun.submitOwner), false);
    const reloaded = new MemoryProtectionTransactions(memory);
    assert.equal(await reloaded.hasUnresolved(), failure === 'precommit');
    assert.equal((await reloaded.loadProtectedClose(order.id))?.submitState, 'claimed');
  }
});

test('reservation cancellation competes with forfeit and keeps history without ID reuse', async () => {
  for (const cancelFirst of [true, false]) {
    const { memory, store, proof } = await ready();
    const other = new MemoryProtectionTransactions(memory);
    const reserved = value(await store.reserveProtectedClose(proof, order, account));
    const cancel = () =>
      store.cancelProtectedCloseBeforeSend(reserved.reservationOwner, 'stopped-before-send');
    const forfeit = () =>
      other.forfeitUnclaimedProtectedClose(
        reserved.order.protectionLink,
        reserved.order.orderVersion,
      );
    const [first, second] = cancelFirst
      ? [await cancel(), await forfeit()]
      : [await forfeit(), await cancel()];
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal((await other.history()).length, 1);
    const p = (await other.loadProtection())!;
    const attempt = value(await other.beginEvidence(ref(p), 'close', 'fresh-owner-test'));
    const fresh = value(
      await other.finishEvidence({
        ...attempt,
        parent: { status: 'never-triggered' },
        children: [],
      }),
    ).closeProof!;
    assert.equal((await other.reserveProtectedClose(fresh, order, account)).ok, false);
    assert.equal(
      (await other.reserveProtectedClose(fresh, { ...order, id: 'fresh-order' }, account)).ok,
      true,
    );
  }
});
