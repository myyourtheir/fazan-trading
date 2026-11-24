import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrderIntent } from './robot.js';
import {
  MemoryProtectionTransactions,
  ProtectionMemory,
} from './protection-transactions.test-support.js';

const order: OrderIntent = {
  id: 'entry',
  accountId: 'a',
  instrumentUid: 'i',
  ticker: 'T',
  timeframe: '1h',
  context: { type: 'signal', candleTime: 1, signalTime: 2, strategy: { kind: 'improved' } },
  direction: 'buy',
  lots: 2,
  fromPosition: 0,
  targetPosition: 2,
};
const result = {
  status: 'reconciled' as const,
  brokerOrderId: 'broker',
  brokerStatus: 'filled' as const,
  executedLots: 2,
  executions: [
    { tradeId: 'fill-1', lots: 1, price: 100, time: 1 },
    { tradeId: 'fill-2', lots: 1, price: 101, time: 2 },
  ],
  position: 2,
};

test('entry claim is one-shot, process-local, and cancellation never reuses the order ID', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const begun = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(begun.ok);
  const restarted = new MemoryProtectionTransactions(memory);
  assert.equal(restarted.consumeEntrySubmit(begun.value.owner), false);
  assert.equal(
    (await restarted.cancelEntryBeforeSend(begun.value.owner, 'stopped-before-send')).ok,
    false,
  );
  assert.ok((await store.cancelEntryBeforeSend(begun.value.owner, 'stopped-before-send')).ok);
  assert.equal(store.consumeEntrySubmit(begun.value.owner), false);
  assert.equal(
    (await store.reserveProtectedEntry(order, { id: 'other', stop: 90 }, 'new')).ok,
    false,
  );
  assert.equal((await store.history())[0].status, 'stopped-before-send');
});

test('incomplete entry lookup retains the verified fill count and rows together', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const partial = {
    ...result,
    status: 'unconfirmed' as const,
    brokerStatus: 'partial' as const,
    executedLots: 1,
    executions: result.executions.slice(0, 1),
    position: 1,
  };
  assert.ok(
    (await store.settleProtectedEntry(claim.value.ref, { kind: 'observed', result: partial })).ok,
  );
  const current = await store.loadProtectedEntry();
  assert.ok(current);
  const incomplete = await store.settleProtectedEntry(current.ref, {
    kind: 'observed',
    result: { ...partial, executedLots: null, executions: [], position: null },
  });
  assert.ok(incomplete.ok);
  assert.equal(incomplete.value.order.executedLots, 1);
  assert.deepEqual(incomplete.value.order.executions, partial.executions);
  assert.ok(await store.loadProtectedEntry());
});

test('execution rows without a total prevent later zero-fill release', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const incomplete = await store.settleProtectedEntry(claim.value.ref, {
    kind: 'observed',
    result: {
      ...result,
      status: 'unconfirmed',
      brokerStatus: 'unknown',
      executedLots: null,
      executions: result.executions.slice(0, 1),
      position: null,
    },
  });
  assert.ok(incomplete.ok);
  const restarted = new MemoryProtectionTransactions(memory);
  const current = await restarted.loadProtectedEntry();
  assert.ok(current);
  const zero = await restarted.settleProtectedEntry(current.ref, {
    kind: 'observed',
    result: {
      ...result,
      brokerStatus: 'rejected',
      executedLots: 0,
      executions: [],
      position: 0,
    },
    account: { accountId: 'a', instrumentUid: 'i', position: 0, activeOrders: false },
  });
  assert.equal(zero.ok, false);
  assert.ok(await restarted.loadProtectedEntry());
  assert.equal(await restarted.reserve({ ...order, id: 'other' }), false);
});

test('positive total without execution rows preserves verified evidence and prevents zero-fill release', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const partial = {
    ...result,
    status: 'unconfirmed' as const,
    brokerStatus: 'partial' as const,
    executedLots: 1,
    executions: result.executions.slice(0, 1),
    position: 1,
  };
  assert.ok(
    (await store.settleProtectedEntry(claim.value.ref, { kind: 'observed', result: partial })).ok,
  );
  const current = await store.loadProtectedEntry();
  assert.ok(current);
  const incomplete = await store.settleProtectedEntry(current.ref, {
    kind: 'observed',
    result: { ...result, executions: [] },
    account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
  });
  assert.ok(incomplete.ok);
  assert.equal(incomplete.value.order.executedLots, 1);
  assert.deepEqual(incomplete.value.order.executions, partial.executions);
  assert.equal(incomplete.value.protection, null);
  const restarted = new MemoryProtectionTransactions(memory);
  const guarded = await restarted.loadProtectedEntry();
  assert.ok(guarded);
  const zero = await restarted.settleProtectedEntry(guarded.ref, {
    kind: 'observed',
    result: { ...result, brokerStatus: 'rejected', executedLots: 0, executions: [], position: 0 },
    account: { accountId: 'a', instrumentUid: 'i', position: 0, activeOrders: false },
  });
  assert.equal(zero.ok, false);
  assert.ok(await restarted.loadProtectedEntry());
  assert.equal(await restarted.reserve({ ...order, id: 'other' }), false);
});

test('first observation of a positive total without rows blocks zero-fill after restart', async () => {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const observed = await store.settleProtectedEntry(claim.value.ref, {
    kind: 'observed',
    result: { ...result, executions: [] },
    account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
  });
  assert.ok(observed.ok);
  assert.equal(observed.value.protection, null);

  const restarted = new MemoryProtectionTransactions(memory);
  const guarded = await restarted.loadProtectedEntry();
  assert.ok(guarded);
  const zero = await restarted.settleProtectedEntry(guarded.ref, {
    kind: 'observed',
    result: { ...result, brokerStatus: 'rejected', executedLots: 0, executions: [], position: 0 },
    account: { accountId: 'a', instrumentUid: 'i', position: 0, activeOrders: false },
  });
  assert.equal(zero.ok, false);
  assert.ok(await restarted.loadProtectedEntry());
  assert.equal(await restarted.hasUnresolved(), true);
  assert.equal(await restarted.loadProtection(), null);
  assert.equal(await restarted.reserve({ ...order, id: 'other' }), false);
});

test('entry and protection transfer the same guard across store instances', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const reserved = await a.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  assert.equal(await b.reserve({ ...order, id: 'other' }), false);
  const claimed = await a.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claimed.ok);
  assert.equal((await b.beginEntrySubmit(reserved.value.ref, 'origin')).ok, false);
  assert.equal(
    (await b.settleProtectedEntry(claimed.value.ref, { kind: 'not-sent', origin: 'origin' })).ok,
    false,
  );
  const mismatch = await b.settleProtectedEntry(claimed.value.ref, {
    kind: 'observed',
    result,
    account: { accountId: 'wrong', instrumentUid: 'i', position: 2, activeOrders: false },
  });
  assert.ok(mismatch.ok);
  assert.equal(mismatch.value.protection, null);
  assert.equal(await b.hasUnresolved(), true);
  assert.deepEqual(await b.unresolved(), mismatch.value.order);
  const current = await b.loadProtectedEntry();
  assert.ok(current);
  const settled = await b.settleProtectedEntry(current.ref, {
    kind: 'observed',
    result,
    account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
  });
  assert.ok(settled.ok);
  assert.equal(settled.value.protection?.id, 'stop');
  assert.equal(settled.value.protection?.stop, 90);
  assert.equal(await a.loadProtectedEntry(), null);
  assert.equal(await a.reserve({ ...order, id: 'other' }), false);
  await assert.rejects(a.record(order.id, result));
});

test('inconsistent execution evidence and terminal statuses cannot hand off protection', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const reserved = await store.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const account = { accountId: 'a', instrumentUid: 'i', position: 1, activeOrders: false };
  const partial = {
    ...result,
    executedLots: 1,
    executions: result.executions.slice(0, 1),
    position: 1,
  };
  for (const invalid of [
    { ...result, executions: result.executions.slice(0, 1) },
    { ...result, executions: [result.executions[0], result.executions[0]] },
    { ...partial, brokerStatus: 'rejected' as const },
    { ...partial, brokerStatus: 'filled' as const },
  ]) {
    assert.equal(
      (
        await store.settleProtectedEntry(claim.value.ref, {
          kind: 'observed',
          result: invalid,
          account,
          recoverPartial: true,
        })
      ).ok,
      false,
    );
  }
  assert.ok(await store.loadProtectedEntry());
  const cancelled = { ...partial, brokerStatus: 'cancelled' as const };
  const held = await store.settleProtectedEntry(claim.value.ref, {
    kind: 'observed',
    result: cancelled,
    account,
  });
  assert.ok(held.ok);
  assert.equal(held.value.protection, null);
  const current = await store.loadProtectedEntry();
  assert.ok(current);
  const recovered = await store.settleProtectedEntry(current.ref, {
    kind: 'observed',
    result: cancelled,
    account,
    recoverPartial: true,
  });
  assert.ok(recovered.ok);
  assert.equal(recovered.value.protection?.lots, 1);
});

test('handoff resets evidence from a cleared previous stop', async () => {
  const store = new MemoryProtectionTransactions(new ProtectionMemory());
  const old = await store.reserveProtection({
    id: 'old',
    accountId: 'a',
    instrumentUid: 'i',
    direction: 'sell',
    lots: 2,
    stop: 90,
  });
  assert.ok(old.ok);
  const oldRef = { accountId: 'a', instrumentUid: 'i', stopId: 'old', version: old.value.version };
  const attempt = await store.beginEvidence(oldRef, 'close', 'old-proof');
  assert.ok(attempt.ok);
  const done = await store.finishEvidence({
    ...attempt.value,
    parent: { status: 'triggered', childIds: ['child'] },
    children: [{ childId: 'child', terminal: true, executedLots: 2 }],
  });
  assert.ok(done.ok);
  assert.ok(done.value.closeProof);
  assert.ok(
    (
      await store.clearChildFlat(done.value.closeProof, {
        accountId: 'a',
        instrumentUid: 'i',
        position: 0,
        activeOrders: false,
      })
    ).ok,
  );
  const reserved = await store.reserveProtectedEntry(order, { id: 'new', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await store.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  const settled = await store.settleProtectedEntry(claim.value.ref, {
    kind: 'observed',
    result,
    account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
  });
  assert.ok(settled.ok);
  assert.ok(settled.value.protection);
  assert.equal(store.proofSnapshot(), null);
  const next = await store.beginEvidence(
    {
      accountId: 'a',
      instrumentUid: 'i',
      stopId: 'new',
      version: settled.value.protection.version,
    },
    'close',
    'new-proof',
  );
  assert.ok(next.ok);
  const proof = await store.finishEvidence({
    ...next.value,
    parent: { status: 'never-triggered' },
    children: [],
  });
  assert.ok(proof.ok);
  assert.ok(proof.value.closeProof);
});

test('postcommit handoff fault does not allow another entry or another handoff', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const reserved = await a.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await a.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  memory.failNext = 'postcommit';
  await assert.rejects(
    a.settleProtectedEntry(claim.value.ref, {
      kind: 'observed',
      result,
      account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
    }),
  );
  assert.equal(await b.loadProtectedEntry(), null);
  assert.equal((await b.loadProtection())?.id, 'stop');
  assert.equal(await b.reserve({ ...order, id: 'other' }), false);
});

test('a precommit handoff fault retains the original guarded entry', async () => {
  const memory = new ProtectionMemory();
  const a = new MemoryProtectionTransactions(memory);
  const b = new MemoryProtectionTransactions(memory);
  const reserved = await a.reserveProtectedEntry(order, { id: 'stop', stop: 90 }, 'origin');
  assert.ok(reserved.ok);
  const claim = await a.beginEntrySubmit(reserved.value.ref, 'origin');
  assert.ok(claim.ok);
  memory.failNext = 'precommit';
  await assert.rejects(
    a.settleProtectedEntry(claim.value.ref, {
      kind: 'observed',
      result,
      account: { accountId: 'a', instrumentUid: 'i', position: 2, activeOrders: false },
    }),
  );
  assert.deepEqual((await b.loadProtectedEntry())?.ref, claim.value.ref);
  assert.equal(await b.loadProtection(), null);
  assert.equal(await b.reserve({ ...order, id: 'other' }), false);
});
