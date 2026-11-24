import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryProtectionTransactions,
  ProtectionMemory,
} from './protection-transactions.test-support.js';
import type { ProtectionTransactions, StoredProtection } from './protection-transactions.js';
import {
  Robot,
  type BrokerOrder,
  type ImprovedProtection,
  type OrderIntent,
  type Protection,
  type RecoveredOrder,
  type TradingConfig,
} from './robot.js';

const config: TradingConfig = {
  token: 'fake',
  accountId: 'a',
  instrumentUid: 'i',
  ticker: 'T',
  timeframe: '1h',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const memory = new ProtectionMemory();
  const store = new MemoryProtectionTransactions(memory);
  const setProtection = (value: Protection & Partial<StoredProtection>) => {
    memory.state.protection = {
      version: 1,
      pendingAttempt: null,
      completedAttempt: null,
      ...value,
    };
  };
  setProtection({
    id: 'stop',
    accountId: 'a',
    instrumentUid: 'i',
    direction: 'sell',
    lots: 4,
    stop: 90,
    state: 'confirmed',
  });
  let position = 4;
  let activeOrders = false;
  let evidence: Awaited<ReturnType<NonNullable<ImprovedProtection['closeEvidence']>>> = {
    status: 'unknown',
  };
  let child = { terminal: true, executedLots: 0 as number | null };
  let uncertain = false;
  let closeOutcome: 'filled' | 'cancelled' = 'filled';
  let failRecord = false;
  let failResult = false;
  let failCancel = false;
  let failedRead: 'lookup' | 'parent' | 'child' | undefined;
  let failedChildId: string | undefined;
  let writeGate:
    | { kind: 'marker' | 'result'; entered: () => void; wait: Promise<void> }
    | undefined;
  let positionAfterReserve: number | undefined;
  let observation: Awaited<ReturnType<ImprovedProtection['lookup']>> = { status: 'unknown' };
  let closeLookup: Awaited<ReturnType<ImprovedProtection['lookup']>> = { status: 'cancelled' };
  let orderLookup: BrokerOrder | null = null;
  let selected = config;
  let fault:
    | { operation: keyof ProtectionTransactions; when: 'precommit' | 'postcommit' }
    | undefined;
  let finalCheck: { entered: () => void; wait: Promise<void> } | undefined;
  const events: string[] = [];
  const submitted: OrderIntent[] = [];
  const commits: StoredProtection[] = [];
  const instrument = (currentStore: MemoryProtectionTransactions) =>
    new Proxy<ProtectionTransactions>(currentStore, {
      get(target, key, receiver) {
        const original = Reflect.get(target, key, receiver);
        const kind =
          key === 'beginCancellation'
            ? 'cancellation'
            : key === 'beginEvidence'
              ? 'marker'
              : key === 'finishEvidence'
                ? 'result'
                : undefined;
        if (
          !kind &&
          key !== 'reserveProtectedClose' &&
          key !== 'clearChildFlat' &&
          key !== 'settleProtectedClose' &&
          key !== 'beginProtectedCloseSubmit' &&
          key !== 'cancelProtectedCloseBeforeSend'
        )
          return typeof original === 'function' ? original.bind(target) : original;
        return async (...args: unknown[]) => {
          if (kind) {
            events.push('record:' + kind);
            if (writeGate?.kind === kind) {
              writeGate.entered();
              await writeGate.wait;
            }
            if (failRecord || (failResult && kind === 'result')) {
              failRecord = false;
              failResult = false;
              memory.failNext = 'precommit';
            }
          }
          if (key === fault?.operation) {
            memory.failNext = fault.when;
            fault = undefined;
          }
          const result = await Reflect.apply(original, target, args);
          if (kind && memory.state.protection)
            commits.push(structuredClone(memory.state.protection));
          if (key === 'reserveProtectedClose') {
            const reserved = result as Awaited<
              ReturnType<ProtectionTransactions['reserveProtectedClose']>
            >;
            if (reserved.ok) {
              events.push('reserve:' + reserved.value.order.id);
              if (positionAfterReserve !== undefined) position = positionAfterReserve;
            }
          }
          if (
            (key === 'clearChildFlat' || key === 'settleProtectedClose') &&
            !memory.state.protection
          )
            events.push('clear');
          return result;
        };
      },
    });
  const port: ImprovedProtection = {
    async submit() {
      return 'confirmed';
    },
    async lookup() {
      events.push('lookup');
      if (failedRead === 'lookup') throw new Error('lookup failed');
      if (memory.state.protection?.pendingAttempt?.kind === 'close') return closeLookup;
      return observation;
    },
    async sizing() {
      return { freeMoney: 1, pointValue: 1 };
    },
    async cancel(_config, stop) {
      events.push('cancel:' + stop.id);
      if (failCancel) throw new Error('timeout');
    },
    async closeEvidence(_config, stop) {
      events.push('parent:' + stop.id);
      if (failedRead === 'parent') throw new Error('parent failed');
      return evidence;
    },
    async childEvidence(_config, _stop, id) {
      events.push('child:' + id);
      if (failedRead === 'child' || failedChildId === id) throw new Error('child failed');
      return child;
    },
  };
  const makeRobot = (currentStore = new MemoryProtectionTransactions(memory)) =>
    new Robot(
      {
        async verifySelection() {},
        async accountState() {
          events.push('account');
          if (
            finalCheck &&
            Object.values(memory.state.orders).some(
              (order) =>
                'submitState' in order &&
                order.submitState === 'claimed' &&
                order.status === 'reserved',
            )
          ) {
            const gate = finalCheck;
            finalCheck = undefined;
            gate.entered();
            await gate.wait;
          }
          return { position, activeOrders };
        },
        async submit(_token, order) {
          events.push('send:' + order.id);
          submitted.push(order);
          if (closeOutcome === 'cancelled')
            return { brokerOrderId: 'b', brokerStatus: 'cancelled', executedLots: 0 };
          position = order.targetPosition;
          if (uncertain) throw new Error('timeout');
          return { brokerOrderId: 'b', brokerStatus: 'filled', executedLots: order.lots };
        },
        async orderState(_token, order) {
          events.push('order:' + order.id);
          if (orderLookup) return orderLookup;
          if (order.id !== 'manual' && !submitted.some((entry) => entry.id === order.id))
            throw new Error('not found');
          if (closeOutcome === 'cancelled')
            return {
              brokerOrderId: 'b',
              brokerStatus: 'cancelled',
              executedLots: 0,
              executions: [],
            };
          return {
            brokerOrderId: 'b',
            brokerStatus: 'filled',
            executedLots: order.lots,
            executions: [{ tradeId: 'f', lots: order.lots, price: 1, time: 1 }],
          };
        },
      },
      {
        protection: instrument(currentStore),
        reserve: currentStore.reserve.bind(currentStore),
        record: currentStore.record.bind(currentStore),
        hasUnresolved: currentStore.hasUnresolved.bind(currentStore),
        unresolved: currentStore.unresolved.bind(currentStore),
        history: currentStore.history.bind(currentStore),
      },
      {
        async subscribe() {
          return () => {};
        },
      },
      async () => selected,
      () => 1,
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
        protection: port,
        async session() {
          return null;
        },
      },
    );
  const robot = makeRobot();
  return {
    robot,
    makeRobot,
    events,
    submitted,
    commits,
    setEvidence: (value: typeof evidence) => {
      evidence = value;
    },
    setChild: (value: typeof child) => {
      child = value;
    },
    setPosition: (value: number) => {
      position = value;
    },
    setActive: (value: boolean) => {
      activeOrders = value;
    },
    setUncertain: () => {
      uncertain = true;
    },
    setCloseOutcome: (value: typeof closeOutcome) => {
      closeOutcome = value;
    },
    failRecord: () => {
      failRecord = true;
    },
    failResult: () => {
      failResult = true;
    },
    failCancel: () => {
      failCancel = true;
    },
    setObservation: (value: typeof observation) => {
      observation = value;
    },
    setCloseLookup: (value: typeof closeLookup) => {
      closeLookup = value;
    },
    setOrderLookup: (value: BrokerOrder) => {
      orderLookup = value;
    },
    setSelection: (value: TradingConfig) => {
      selected = value;
    },
    fault: (operation: keyof ProtectionTransactions, when: 'precommit' | 'postcommit') => {
      fault = { operation, when };
    },
    gateFinalCheck: () => {
      const entered = deferred();
      const release = deferred();
      finalCheck = { entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: release.resolve };
    },
    setProtection,
    setUnresolved: (value: RecoveredOrder) => {
      memory.state.orders[value.id] = value;
    },
    failRead: (value: typeof failedRead) => {
      failedRead = value;
    },
    failChild: (id: string) => {
      failedChildId = id;
    },
    gateWrite: (kind: 'marker' | 'result') => {
      const entered = deferred();
      const release = deferred();
      writeGate = { kind, entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: release.resolve };
    },
    changePositionAfterReserve: (value: number) => {
      positionAfterReserve = value;
    },
    saved: () => memory.state.protection,
    unresolved: () => store.unresolved(),
  };
}

test('manual close persists cancellation before request and requires proof before reserve', async () => {
  const s = setup();
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.deepEqual(s.events, [
    'account',
    'record:cancellation',
    'cancel:stop',
    'record:marker',
    'parent:stop',
    'record:result',
  ]);
  s.setEvidence({ status: 'never-triggered' });
  await s.robot.closePosition(config);
  assert.equal(s.events.filter((e) => e === 'cancel:stop').length, 1);
  const reserve = s.events.findIndex((e) => e.startsWith('reserve:'));
  const send = s.events.findIndex((e) => e.startsWith('send:'));
  assert.ok(reserve > 0 && send > reserve);
  assert.equal(s.events[send - 1], 'account');
  assert.equal(s.saved(), null);
  assert.equal(s.robot.status().reason, null);
});

test('protected short closes with a buy after verified cancellation', async () => {
  const s = setup();
  s.setProtection({ ...s.saved()!, direction: 'buy' });
  s.setPosition(-4);
  s.setEvidence({ status: 'never-triggered' });
  await s.robot.closePosition(config);
  assert.equal(s.robot.status().position, 0);
  assert.equal(s.events.filter((e) => e.startsWith('send:')).length, 1);
  assert.equal(s.submitted[0]?.direction, 'buy');
  assert.equal(s.submitted[0]?.lots, 4);
});

test('protected close does not send after position changes during reservation', async () => {
  const s = setup();
  s.setEvidence({ status: 'never-triggered' });
  s.changePositionAfterReserve(2);
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_POSITION_CHANGED' });
  assert.ok(!s.events.some((e) => e.startsWith('send:')));
  assert.ok(s.saved());
});

test('a failed cancellation write is retried before cancellation', async () => {
  const s = setup();
  s.failRecord();
  await assert.rejects(s.robot.closePosition(config), /precommit/);
  assert.ok(!s.events.includes('cancel:stop'));
  s.setEvidence({ status: 'never-triggered' });
  await s.robot.closePosition(config);
  assert.equal(s.events.filter((e) => e.startsWith('record:')).length, 4);
  assert.equal(s.events.filter((e) => e === 'cancel:stop').length, 1);
});

test('ambiguous cancellation uses evidence rather than sending cancellation again', async () => {
  const s = setup();
  s.failCancel();
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setEvidence({ status: 'never-triggered' });
  await s.robot.closePosition(config);
  assert.equal(s.events.filter((e) => e === 'cancel:stop').length, 1);
});

test('reconcile observation adds child evidence even when a child list already exists', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['first'] });
  s.setChild({ terminal: false, executedLots: 0 });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setObservation({ status: 'triggered', childId: 'second', childStatus: 'terminal' });
  await s.robot.reconcileProtection();
  s.setEvidence({ status: 'triggered', childIds: ['first'] });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.deepEqual(s.saved()?.childIds, ['first', 'second']);
  assert.ok(!s.events.some((e) => e.startsWith('send:')));
});

test('triggered child requires independent terminal fills and residual position match', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['child'] });
  s.setChild({ terminal: false, executedLots: 2 });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setChild({ terminal: true, executedLots: 2 });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_POSITION_CHANGED' });
  s.setPosition(2);
  await s.robot.closePosition(config);
  assert.ok(s.events.includes('child:child'));
  assert.equal(s.saved(), null);
});

test('flat after verified child does not send; selection and active orders block cancellation', async () => {
  const s = setup();
  await assert.rejects(s.robot.closePosition({ ...config, accountId: 'other' }), {
    code: 'ROBOT_SELECTION_CHANGED',
  });
  s.setActive(true);
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_ACTIVE_ORDERS' });
  assert.ok(!s.events.includes('cancel:stop'));
  s.setActive(false);
  s.setEvidence({ status: 'triggered', childIds: ['child'] });
  s.setChild({ terminal: true, executedLots: 4 });
  s.setPosition(0);
  await s.robot.closePosition(config);
  assert.ok(!s.events.some((e) => e.startsWith('send:')));
  assert.equal(s.saved(), null);
});

test('ambiguous exit retains protection until original order reconciles', async () => {
  const s = setup();
  s.setEvidence({ status: 'never-triggered' });
  s.setUncertain();
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_ORDER_UNRESOLVED' });
  assert.ok(s.saved());
  const sent = s.events.find((e) => e.startsWith('send:'))!.slice(5);
  const restarted = s.makeRobot();
  await restarted.restore();
  assert.equal(restarted.status().mode, 'stopped');
  assert.deepEqual(restarted.status().recovery, { orderId: sent, ready: false });
  await restarted.reconcile();
  assert.equal(s.events.filter((e) => e === 'order:' + sent).length, 2);
  assert.equal(s.saved(), null);
  assert.equal(s.events.filter((e) => e.startsWith('send:')).length, 1);
});

test('a cached cancellation and an unknown fresh lookup do not authorize exit', async () => {
  const s = setup();
  s.setObservation({ status: 'cancelled' });
  await s.robot.reconcileProtection();
  s.setEvidence({ status: 'never-triggered' });
  s.setCloseLookup({ status: 'unknown' });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.equal(s.submitted.length, 0);
  assert.equal(await s.unresolved(), null);
  assert.deepEqual(s.saved()?.observation, { status: 'cancelled' });
});

test('authoritative zero fill releases only the order and a new close needs fresh proof and ID', async () => {
  const s = setup();
  s.setEvidence({ status: 'never-triggered' });
  s.setCloseOutcome('cancelled');
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_ORDER_UNRESOLVED' });
  const firstId = s.submitted[0]!.id;
  assert.equal((await s.unresolved())?.id, firstId);
  const fresh = s.makeRobot();
  await fresh.restore();
  await fresh.reconcile();
  assert.ok(s.saved());
  assert.equal(await s.unresolved(), null);
  assert.equal(s.events.filter((e) => e === 'order:' + firstId).length, 2);
  s.setCloseOutcome('filled');
  await fresh.closePosition(config);
  assert.notEqual(s.submitted[1]?.id, firstId);
  assert.equal(s.events.filter((e) => e === 'parent:stop').length, 2);
  assert.equal(s.events.filter((e) => e === 'cancel:stop').length, 1);
  assert.equal(s.saved(), null);
});

test('a second Robot cannot send or release a live claim before the first RPC', async () => {
  const s = setup();
  s.setEvidence({ status: 'never-triggered' });
  const gate = s.gateFinalCheck();
  const close = s.robot.closePosition(config);
  await gate.entered;
  try {
    const other = s.makeRobot();
    await other.restore();
    const original = (await s.unresolved())!;
    assert.deepEqual(other.status().recovery, { orderId: original.id, ready: false });
    s.setPosition(0);
    await other.reconcile();
    assert.equal((await s.unresolved())?.id, original.id);
    assert.ok(s.saved());
    assert.deepEqual(s.submitted, []);
    await assert.rejects(other.closePosition(config), { code: 'ROBOT_ORDER_UNRESOLVED' });
    s.setPosition(4);
  } finally {
    gate.release();
  }
  await close;
  assert.equal(s.submitted.length, 1);
  assert.equal(s.saved(), null);
});

for (const interruption of ['selection', 'credentials', 'stop'] as const) {
  test(`${interruption} during the claimed account check cancels without sending`, async () => {
    const s = setup();
    s.setEvidence({ status: 'never-triggered' });
    const gate = s.gateFinalCheck();
    const close = s.robot.closePosition(config);
    await gate.entered;
    if (interruption === 'stop') s.robot.stop();
    else if (interruption === 'selection') s.setSelection({ ...config, accountId: 'other' });
    else s.setSelection({ ...config, token: 'new-token' });
    gate.release();
    await assert.rejects(close, {
      code: interruption === 'stop' ? 'ROBOT_PROTECTION_UNRESOLVED' : 'ROBOT_SELECTION_CHANGED',
    });
    assert.deepEqual(s.submitted, []);
    assert.equal(await s.unresolved(), null);
    assert.ok(s.saved());
  });
}

for (const operation of [
  'reserveProtectedClose',
  'beginProtectedCloseSubmit',
  'cancelProtectedCloseBeforeSend',
] as const) {
  test(`lost ${operation} acknowledgement does not grant dispatch authority`, async () => {
    const s = setup();
    s.setEvidence({ status: 'never-triggered' });
    if (operation === 'cancelProtectedCloseBeforeSend') s.changePositionAfterReserve(2);
    s.fault(operation, 'postcommit');
    await assert.rejects(s.robot.closePosition(config), /postcommit/);
    assert.deepEqual(s.submitted, []);
    const restarted = s.makeRobot();
    await restarted.restore();
    const order = await s.unresolved();
    if (operation === 'cancelProtectedCloseBeforeSend') assert.equal(order, null);
    else {
      assert.ok(order);
      assert.deepEqual(restarted.status().recovery, { orderId: order.id, ready: false });
      if (operation === 'reserveProtectedClose')
        await assert.rejects(restarted.reconcile(), { code: 'ROBOT_ORDER_UNRESOLVED' });
      else await restarted.reconcile();
      assert.equal((await s.unresolved())?.id, order.id);
    }
    assert.ok(s.saved());
    assert.deepEqual(s.submitted, []);
  });
}

test('a failed first settlement with a positive submit cannot be released by zero-fill recovery', async () => {
  const s = setup();
  s.setEvidence({ status: 'never-triggered' });
  s.fault('settleProtectedClose', 'precommit');
  await assert.rejects(s.robot.closePosition(config), /precommit/);
  const originalId = s.submitted[0]!.id;
  s.setPosition(4);
  s.setOrderLookup({
    brokerOrderId: 'b',
    brokerStatus: 'cancelled',
    executedLots: 0,
    executions: [],
  });
  const fresh = s.makeRobot();
  await fresh.restore();
  await fresh.reconcile();
  assert.equal((await s.unresolved())?.id, originalId);
  await s.robot.reconcile();
  assert.equal((await s.unresolved())?.executedLots, 4);
  assert.equal(s.submitted.length, 1);
  assert.ok(s.saved());
});

test('contradictory parent evidence preserves child identity and stays blocked', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['child'] });
  s.setChild({ terminal: false, executedLots: 0 });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setEvidence({ status: 'never-triggered' });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.deepEqual(s.saved()?.childIds, ['child']);
  s.setEvidence({ status: 'triggered', childIds: ['child'] });
  s.setChild({ terminal: true, executedLots: 0 });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.ok(!s.events.some((e) => e.startsWith('send:')));
});

test('failed contradictory evidence write leaves the marker, not a partial result', async () => {
  const s = setup();
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setEvidence({ status: 'triggered', childIds: ['child', 'child'] });
  s.failResult();
  await assert.rejects(s.robot.closePosition(config), /precommit/);
  assert.deepEqual(s.saved()?.childIds, []);
  assert.equal(s.saved()?.evidenceConflict, undefined);
  assert.ok(s.saved()?.pendingAttempt);
  assert.deepEqual(s.robot.status().protection, s.saved());
  assert.ok(!s.events.some((e) => e.startsWith('send:')));
});

test('restore on the same robot preserves the blocking marker after a failed conflict write', async () => {
  const s = setup();
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  s.setEvidence({ status: 'triggered', childIds: ['child', 'child'] });
  s.failResult();
  await assert.rejects(s.robot.closePosition(config), /precommit/);
  const marker = s.saved()?.pendingAttempt;
  assert.ok(marker);
  await s.robot.restore();
  assert.deepEqual(s.robot.status().protection?.pendingAttempt, marker);
  s.setEvidence({ status: 'never-triggered' });
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.ok(!s.events.some((e) => e.startsWith('reserve:') || e.startsWith('send:')));
});

test('failed evidence marker prevents either broker lookup', async () => {
  const reconcile = setup();
  reconcile.failRecord();
  await assert.rejects(reconcile.robot.reconcileProtection(), /precommit/);
  assert.ok(!reconcile.events.includes('lookup'));

  const close = setup();
  await assert.rejects(close.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  close.events.length = 0;
  close.failRecord();
  await assert.rejects(close.robot.closePosition(config), /precommit/);
  assert.ok(!close.events.includes('parent:stop'));
});

for (const source of ['lookup', 'parent'] as const) {
  test(`${source} result write failure survives same-instance restore and process restart`, async () => {
    const s = setup();
    if (source === 'lookup')
      s.setObservation({ status: 'triggered', childId: 'child', childStatus: 'terminal' });
    else {
      await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
      s.setEvidence({ status: 'triggered', childIds: ['child'] });
    }
    s.failResult();
    await assert.rejects(
      source === 'lookup' ? s.robot.reconcileProtection() : s.robot.closePosition(config),
      /precommit/,
    );
    assert.ok(s.saved()?.pendingAttempt);
    assert.deepEqual(s.robot.status().protection, s.saved());
    s.setEvidence({ status: 'never-triggered' });
    s.setObservation({ status: 'absent' });
    s.setPosition(0);
    await s.robot.restore();
    const fresh = s.makeRobot();
    await fresh.restore();
    for (const robot of [s.robot, fresh]) {
      await assert.rejects(robot.reconcileProtection(), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
      await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
    }
    assert.ok(
      !s.events.some((e) => e.startsWith('reserve:') || e.startsWith('send:') || e === 'clear'),
    );
  });
}

test('marker identifies the attempt and stays durable through all child reads before the result', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['one', 'two'] });
  await s.robot.closePosition(config);
  const marker = s.commits.find((record) => record.pendingAttempt)?.pendingAttempt;
  assert.ok(marker?.attemptId);
  assert.deepEqual(
    { stopId: marker.stopId, accountId: marker.accountId, instrumentUid: marker.instrumentUid },
    { stopId: 'stop', accountId: 'a', instrumentUid: 'i' },
  );
  const start = s.events.indexOf('record:marker');
  const parent = s.events.indexOf('parent:stop');
  const one = s.events.indexOf('child:one');
  const two = s.events.indexOf('child:two');
  const result = s.events.indexOf('record:result');
  const reserve = s.events.findIndex((event) => event.startsWith('reserve:'));
  assert.ok(start < parent && parent < one && one < two && two < result && result < reserve);
  const persisted = s.commits.find((record) => record.closeObservation?.status === 'triggered');
  assert.deepEqual(persisted?.childIds, ['one', 'two']);
  assert.deepEqual(persisted?.childObservations, {
    one: { terminal: true, executedLots: 0 },
    two: { terminal: true, executedLots: 0 },
  });
  assert.equal(persisted?.pendingAttempt, null);
});

test('evidence reads and exit effects await durable marker and result writes', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['one', 'two'] });
  const marker = s.gateWrite('marker');
  const closing = s.robot.closePosition(config);
  await marker.entered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(s.saved()?.pendingAttempt, null);
  assert.ok(!s.commits.some((value) => value.pendingAttempt));
  assert.ok(!s.events.some((event) => /^(lookup|parent:|child:)/.test(event)));
  const result = s.gateWrite('result');
  marker.release();
  await result.entered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(s.saved()?.pendingAttempt);
  assert.equal(s.commits.filter((value) => value.pendingAttempt).length, 1);
  assert.ok(!s.commits.some((value) => value.closeObservation));
  assert.deepEqual(
    s.events.filter((event) => event.startsWith('child:')),
    ['child:one', 'child:two'],
  );
  assert.ok(
    !s.events.some(
      (event) => event.startsWith('reserve:') || event.startsWith('send:') || event === 'clear',
    ),
  );
  result.release();
  await closing;
  assert.ok(s.events.some((event) => event.startsWith('reserve:')));
  assert.ok(s.events.some((event) => event.startsWith('send:')));
  assert.ok(s.events.includes('clear'));
});

test('failure on second child leaves only the durable marker across restart', async () => {
  const s = setup();
  s.setEvidence({ status: 'triggered', childIds: ['one', 'two'] });
  s.failChild('two');
  await assert.rejects(s.robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.deepEqual(
    s.events.filter((event) => event.startsWith('child:')),
    ['child:one', 'child:two'],
  );
  assert.ok(s.saved()?.pendingAttempt?.attemptId);
  const marker = s.commits.find((value) => value.pendingAttempt);
  assert.ok(marker);
  assert.deepEqual(s.saved(), marker);
  assert.ok(!s.events.includes('record:result'));
  const fresh = s.makeRobot();
  await fresh.restore();
  assert.deepEqual(fresh.status().protection, marker);
  assert.ok(
    !s.events.some(
      (event) => event.startsWith('reserve:') || event.startsWith('send:') || event === 'clear',
    ),
  );
});

for (const source of ['lookup', 'parent', 'child'] as const) {
  test(`${source} lookup failure leaves durable pending evidence across restart`, async () => {
    const s = setup();
    s.setEvidence({ status: 'triggered', childIds: ['child'] });
    s.failRead(source);
    await assert.rejects(
      source === 'lookup' ? s.robot.reconcileProtection() : s.robot.closePosition(config),
      { code: 'ROBOT_PROTECTION_UNRESOLVED' },
    );
    assert.ok(s.saved()?.pendingAttempt?.attemptId);
    assert.ok(!s.events.includes('record:result'));
    const fresh = s.makeRobot();
    await fresh.restore();
    await assert.rejects(fresh.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
    assert.ok(!s.events.some((event) => event.startsWith('reserve:') || event === 'clear'));
  });
}

test('fresh recovery of a filled manual close cannot clear pending protection', async () => {
  const s = setup();
  s.setPosition(0);
  s.setProtection({
    ...s.saved()!,
    pendingAttempt: {
      attemptId: 'attempt',
      stopId: 'stop',
      accountId: 'a',
      instrumentUid: 'i',
      kind: 'close',
      version: 1,
    },
  });
  s.setUnresolved({
    id: 'manual',
    accountId: 'a',
    instrumentUid: 'i',
    ticker: 'T',
    timeframe: '1h',
    context: { type: 'manual-close', time: 1 },
    direction: 'sell',
    lots: 4,
    fromPosition: 4,
    targetPosition: 0,
    status: 'unconfirmed',
    brokerOrderId: 'b',
    brokerStatus: 'filled',
    executedLots: 4,
    executions: [{ tradeId: 'f', lots: 4, price: 1, time: 1 }],
    position: null,
  });
  const fresh = s.makeRobot();
  await fresh.restore();
  assert.ok(!s.events.includes('order:manual'));
  await fresh.reconcile();
  assert.ok(s.events.includes('order:manual'));
  assert.deepEqual(fresh.status().recovery, { orderId: 'manual', ready: true });
  assert.equal(fresh.status().position, 0);
  assert.equal(await s.unresolved(), null);
  assert.equal(s.saved()?.pendingAttempt?.attemptId, 'attempt');
  await fresh.reconcile();
  assert.equal(s.saved()?.pendingAttempt?.attemptId, 'attempt');
  assert.ok(!s.events.includes('clear'));
});
