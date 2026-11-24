import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Robot,
  type ImprovedProtection,
  type ProtectionObservation,
  type TradingConfig,
} from './robot.js';
import {
  MemoryProtectionTransactions,
  ProtectionMemory,
} from './protection-transactions.test-support.js';

const config: TradingConfig = {
  token: 'fake',
  accountId: 'a',
  instrumentUid: 'i',
  ticker: 'T',
  timeframe: '1h',
};

async function fixture(lookup: ImprovedProtection['lookup']) {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const reserved = await store.reserveProtection({
    id: 'stop',
    accountId: 'a',
    instrumentUid: 'i',
    direction: 'sell',
    lots: 2,
    stop: 90,
  });
  assert.ok(reserved.ok);
  const protection: ImprovedProtection = {
    async submit() {
      return 'confirmed';
    },
    lookup,
    async sizing() {
      return { freeMoney: 1, pointValue: 1 };
    },
  };
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        return { position: 2, activeOrders: false };
      },
      async submit() {
        throw new Error('unexpected submit');
      },
      async orderState() {
        throw new Error('unexpected lookup');
      },
    },
    store,
    {
      async subscribe() {
        return () => {};
      },
    },
    async () => config,
    () => 0,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      parameters: {
        emaPeriod: 55,
        atrPeriod: 20,
        stopAtrMultiplier: 2,
        addStepAtr: 1,
        maxAddOns: 3,
        tradeWeekends: false,
      },
      protection,
      async session() {
        return null;
      },
    },
  );
  return { memory, store, robot };
}

test('robot publishes the durable pending marker before lookup and retains it on broker failure', async () => {
  let fail = false;
  let calls = 0;
  const { store, robot } = await fixture(async () => {
    calls++;
    assert.equal((await store.loadProtection())?.pendingAttempt?.kind, 'lookup');
    assert.equal(robot.status().protection?.pendingAttempt?.kind, 'lookup');
    if (fail) throw new Error('offline');
    return { status: 'triggered', childId: 'child', childStatus: 'unknown' };
  });
  const published: Array<string | undefined> = [];
  robot.subscribe(() => published.push(robot.status().protection?.pendingAttempt?.kind));
  await robot.reconcileProtection();
  assert.ok(published.includes('lookup'));
  assert.deepEqual((await store.loadProtection())?.childIds, ['child']);
  assert.equal(robot.status().reason, 'ROBOT_PROTECTION_UNRESOLVED');
  fail = true;
  await assert.rejects(robot.reconcileProtection());
  assert.equal((await store.loadProtection())?.pendingAttempt?.kind, 'lookup');
  assert.equal(robot.status().protection?.pendingAttempt?.kind, 'lookup');
  await assert.rejects(robot.reconcileProtection());
  assert.equal(calls, 2);
});

test('lookup retains triggered child evidence through incomplete observations', async () => {
  const observations: ProtectionObservation[] = [
    { status: 'triggered', childId: 'child', childStatus: 'active' },
    { status: 'triggered', childId: 'child', childStatus: 'unknown' },
    { status: 'absent' },
    { status: 'unknown' },
  ];
  const { robot } = await fixture(async () => observations.shift()!);
  for (let i = 0; i < 4; i++) {
    await robot.reconcileProtection();
    assert.deepEqual(robot.status().protection?.observation, {
      status: 'triggered',
      childId: 'child',
      childStatus: 'active',
    });
    assert.deepEqual(robot.status().protection?.childIds, ['child']);
  }
});

test('rejected begin never reads the broker', async () => {
  let calls = 0;
  const { memory, robot, store } = await fixture(async () => {
    calls++;
    return { status: 'unknown' };
  });
  memory.failNext = 'precommit';
  await assert.rejects(robot.reconcileProtection());
  assert.equal(calls, 0);
  assert.equal((await store.loadProtection())?.pendingAttempt, null);
});

test('lost begin acknowledgement refreshes the committed marker without a broker lookup', async () => {
  let calls = 0;
  const { memory, robot, store } = await fixture(async () => {
    calls++;
    return { status: 'unknown' };
  });
  memory.failNext = 'postcommit';
  await assert.rejects(robot.reconcileProtection());
  assert.equal(calls, 0);
  assert.equal((await store.loadProtection())?.pendingAttempt?.kind, 'lookup');
  assert.deepEqual(
    robot.status().protection?.pendingAttempt,
    (await store.loadProtection())?.pendingAttempt,
  );
  assert.equal(robot.status().reason, 'ROBOT_PROTECTION_UNRESOLVED');
});

test('failed refresh after begin failure retains unresolved protection', async () => {
  let calls = 0;
  const { memory, robot, store } = await fixture(async () => {
    calls++;
    return { status: 'unknown' };
  });
  const load = store.loadProtection.bind(store);
  let refreshAttempted = false;
  store.loadProtection = async () => {
    if (memory.state.protection?.pendingAttempt?.kind === 'lookup') {
      refreshAttempted = true;
      throw new Error('refresh failed');
    }
    return load();
  };
  memory.failNext = 'postcommit';
  await assert.rejects(robot.reconcileProtection(), { message: 'postcommit' });
  assert.equal(refreshAttempted, true);
  assert.equal(calls, 0);
  assert.equal(robot.status().protection?.id, 'stop');
  assert.equal(robot.status().reason, 'ROBOT_PROTECTION_UNRESOLVED');
});

for (const status of ['active', 'cancelled'] as const) {
  test(`lookup retains ${status} after an unknown observation`, async () => {
    const observations: ProtectionObservation[] = [{ status }, { status: 'unknown' }];
    let calls = 0;
    const { robot, store } = await fixture(async () => {
      calls++;
      return observations.shift()!;
    });
    await robot.reconcileProtection();
    const firstAttempt = (await store.loadProtection())?.completedAttempt;
    assert.equal(firstAttempt?.kind, 'lookup');
    await robot.reconcileProtection();
    const protection = await store.loadProtection();
    assert.equal(calls, 2);
    assert.deepEqual(robot.status().protection?.observation, { status });
    assert.deepEqual(protection?.observation, { status });
    assert.equal(protection?.pendingAttempt, null);
    assert.equal(protection?.completedAttempt?.kind, 'lookup');
    assert.notEqual(protection?.completedAttempt?.attemptId, firstAttempt?.attemptId);
    assert.ok(protection!.completedAttempt!.version > firstAttempt!.version);
    assert.equal(robot.status().protection?.pendingAttempt, null);
    assert.deepEqual(robot.status().protection?.completedAttempt, protection?.completedAttempt);
  });
}

test('finish precommit failure remains pending in status and after restore', async () => {
  let calls = 0;
  const { memory, robot, store } = await fixture(async () => {
    calls++;
    memory.failNext = 'precommit';
    return { status: 'triggered', childId: 'child', childStatus: 'active' };
  });
  await assert.rejects(robot.reconcileProtection());
  assert.equal(robot.status().protection?.pendingAttempt?.kind, 'lookup');
  assert.equal(robot.status().protection?.observation, undefined);
  assert.equal((await store.loadProtection())?.pendingAttempt?.kind, 'lookup');
  await robot.restore();
  assert.equal(robot.status().protection?.pendingAttempt?.kind, 'lookup');
  assert.equal(robot.status().protection?.observation, undefined);
  assert.equal(robot.status().reason, 'ROBOT_PROTECTION_UNRESOLVED');
  await assert.rejects(robot.reconcileProtection());
  assert.equal(calls, 1);
});
