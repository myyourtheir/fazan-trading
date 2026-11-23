import { surfingJournalProjection } from './surfing-journal.js';
import { surfingStrategy } from '../core/surfing-strategy.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { MarketUpdate } from '../core/market-data.js';
import { Robot, type Broker, type OrderIntent } from '../core/robot.js';
import { SandboxConnection } from '../core/sandbox.js';
import { fakeBroker, token } from '../core/sandbox.test-support.js';
import { StrategySettings } from '../core/strategy-settings.js';
import { timeframeMs } from '../core/timeframe.js';
import {
  connectToPostgres,
  ensureAppOwner,
  migrateDatabase,
  PostgresDisplaySettings,
  PostgresSandboxConnection,
  PostgresStrategySettings,
  PostgresTradingStore,
} from './postgres.js';
import { TokenCipher } from './token-cipher.js';

const testDatabase = process.env.SERFING_TEST_DATABASE_URL;
const cipher = new TokenCipher('ab'.repeat(32));
const hourMs = timeframeMs['1h'];

test(
  'PostgreSQL restores the latest display timezone after reconnecting',
  { skip: !testDatabase },
  async () => {
    const first = connectToPostgres(testDatabase);
    try {
      await migrateDatabase(first.db);
      const store = new PostgresDisplaySettings(first.db);
      await store.saveTimeZone('Asia/Kolkata');
      await store.saveTimeZone('America/New_York');
    } finally {
      await first.close();
    }
    const restarted = connectToPostgres(testDatabase);
    try {
      assert.equal(
        await new PostgresDisplaySettings(restarted.db).loadTimeZone(),
        'America/New_York',
      );
    } finally {
      await restarted.close();
    }
  },
);

test(
  'PostgreSQL restores one active strategy, including the exact contract, without the broker',
  { skip: !testDatabase && 'Requires a disposable PostgreSQL database' },
  async () => {
    const first = connectToPostgres(testDatabase);
    const { broker, goOffline } = fakeBroker();
    const encryptedToken = cipher.encrypt(token);
    const sandbox = new SandboxConnection(
      {
        async load() {
          return { encryptedToken, accountId: 'existing' };
        },
        async save() {
          assert.fail('Unexpected account change');
        },
      },
      cipher,
      broker,
    );
    let expected;
    let expectedImproved;
    try {
      await migrateDatabase(first.db);
      const service = new StrategySettings(
        new PostgresStrategySettings(first.db, await ensureAppOwner(first.db)),
        sandbox,
      );
      await service.search('IMOEXF');
      await service.save({
        accountId: 'existing',
        instrumentUid: 'contract-a',
        emaPeriod: 55,
        lots: 1,
        timeframe: '1h',
      });
      await service.save({
        accountId: 'existing',
        instrumentUid: 'contract-b',
        emaPeriod: 34,
        lots: 7,
        timeframe: '30m',
      });
      expected = await service.get();
      assert.equal(expected.settings?.instrument.uid, 'contract-b');
      assert.equal(expected.settings?.parameters.emaPeriod, 34);
      assert.equal(expected.settings?.parameters.lots, 7);
      assert.equal(expected.settings?.timeframe, '30m');
      await service.saveImproved('existing', 'contract-a', '5m', {
        emaPeriod: 21,
        atrPeriod: 14,
        stopAtrMultiplier: 2,
        addStepAtr: 1,
        maxAddOns: 3,
        tradeWeekends: false,
      });
      await service.select('existing', 'improved-surfing');
      expectedImproved = await service.selectedProfile();
      assert.equal(expectedImproved?.instrument.uid, 'contract-a');
      assert.deepEqual(await service.get(), expected);
      assert.equal((await first.db.$client.query('SELECT * FROM strategy_profiles')).rowCount, 2);
    } finally {
      await first.close();
    }
    goOffline();
    const restarted = connectToPostgres(testDatabase);
    try {
      const service = new StrategySettings(
        new PostgresStrategySettings(restarted.db, await ensureAppOwner(restarted.db)),
        sandbox,
      );
      assert.deepEqual(await service.get(), expected);
      assert.equal(await service.selectedKind(), 'improved-surfing');
      assert.deepEqual(await service.selectedProfile(), expectedImproved);
    } finally {
      await restarted.close();
    }
  },
);

test(
  'PostgreSQL restores the encrypted connection and selected account after restart',
  { skip: !testDatabase && 'Requires a disposable PostgreSQL database' },
  async () => {
    const first = connectToPostgres(testDatabase);
    const { broker } = fakeBroker();
    try {
      await migrateDatabase(first.db);
      const service = new SandboxConnection(
        new PostgresSandboxConnection(first.db),
        cipher,
        broker,
      );
      await service.connect(token);
      await service.selectAccount('existing');
      const { rows } = await first.db.$client.query('SELECT * FROM sandbox_connection');
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes(token));
    } finally {
      await first.close();
    }
    const restarted = connectToPostgres(testDatabase);
    try {
      const service = new SandboxConnection(
        new PostgresSandboxConnection(restarted.db),
        new TokenCipher('ab'.repeat(32)),
        broker,
      );
      assert.deepEqual(await service.status(), {
        status: 'connected',
        accountId: 'existing',
        virtualFundingRubles: 100_000,
        accounts: [{ id: 'existing', name: 'Existing sandbox account' }],
      });
    } finally {
      await restarted.close();
    }
  },
);

test(
  'PostgreSQL preserves separate orders and executions and rejects duplicate reservations',
  { skip: !testDatabase },
  async () => {
    assert.ok(testDatabase);
    const order = {
      id: randomUUID(),
      accountId: `test-${randomUUID()}`,
      instrumentUid: 'test-future',
      ticker: 'TEST',
      context: {
        type: 'signal',
        candleTime: Date.UTC(2026, 10, 18, 12),
        signalTime: Date.UTC(2026, 10, 18, 13),
        strategy: { kind: 'surfing', signalPrice: 101, ema: 100 },
      },
      candleTime: Date.UTC(2026, 10, 18, 12),
      signalTime: Date.UTC(2026, 10, 18, 13),
      timeframe: '1h',
      action: 'ema-crossing',
      manualCloseTime: null,
      signalPrice: 101,
      ema: 100,
      direction: 'sell',
      lots: 1,
      fromPosition: 0,
      targetPosition: -1,
    } satisfies OrderIntent & Record<string, unknown>;
    const shorter = {
      ...order,
      id: randomUUID(),
      timeframe: '15m',
      signalTime: order.candleTime + timeframeMs['15m'],
      context: { ...order.context, signalTime: order.candleTime + timeframeMs['15m'] },
    } satisfies OrderIntent & Record<string, unknown>;
    const close = {
      ...order,
      id: randomUUID(),
      direction: 'buy',
      fromPosition: -1,
      targetPosition: 0,
      context: { type: 'manual-close', time: order.signalTime + 4_000 },
      action: 'manual-close',
      candleTime: null,
      signalTime: null,
      signalPrice: null,
      ema: null,
      manualCloseTime: order.signalTime + 4_000,
    } satisfies OrderIntent & Record<string, unknown>;
    const result = {
      status: 'confirmed',
      brokerOrderId: 'exchange-id',
      brokerStatus: 'filled',
      executedLots: 1,
      position: -1,
      executions: [{ tradeId: 'fill', lots: 1, price: 98.5, time: order.signalTime + 3_000 }],
    } as const;
    const first = connectToPostgres(testDatabase);
    try {
      await migrateDatabase(first.db);
      const store = new PostgresTradingStore(first.db, surfingJournalProjection);
      assert.equal(await store.reserve(order), true);
      assert.equal(await store.hasUnresolved(), true);
      assert.equal(
        await store.reserve({
          ...order,
          id: randomUUID(),
          context: { ...order.context, candleTime: order.candleTime + hourMs },
        }),
        false,
      );
      await store.record(order.id, { ...result, executions: [...result.executions] });
      assert.equal(await store.hasUnresolved(), false);
      assert.equal(await store.reserve({ ...order, id: randomUUID() }), false);
      assert.equal(
        await store.reserve(shorter),
        true,
        'a different timeframe has a different candle key',
      );
      await store.record(shorter.id, { ...result, executions: [] });
      assert.equal(await store.reserve({ ...shorter, id: randomUUID() }), false);
      assert.equal(await store.reserve(close), true);
      await store.record(close.id, { ...result, position: 0, executions: [] });
      const repeat = { ...close, id: randomUUID() };
      assert.equal(await store.reserve(repeat), true, 'manual orders do not share a candle key');
      await store.record(repeat.id, { ...result, position: 0, executions: [] });
    } finally {
      await first.close();
    }
    const second = connectToPostgres(testDatabase);
    try {
      const store = new PostgresTradingStore(second.db, surfingJournalProjection);
      const journal = await store.history(order.accountId);
      assert.equal(journal.length, 4);
      const { context: _orderContext, ...journalOrder } = order;
      const { context: _shorterContext, ...journalShorter } = shorter;
      const { context: _closeContext, ...journalClose } = close;
      assert.deepEqual(journal[2], { ...journalOrder, ...result });
      assert.deepEqual(journal[3], { ...journalShorter, ...result, executions: [] });
      assert.deepEqual(
        journal.find((row) => row.id === close.id),
        { ...journalClose, ...result, position: 0, executions: [] },
      );
      assert.deepEqual(await store.history(`test-${randomUUID()}`), []);
    } finally {
      await second.close();
    }
  },
);

test(
  'a restarted robot restores persisted settings and the reserved client ID without resending a replay',
  { skip: !testDatabase },
  async () => {
    const { broker: sandboxBroker } = fakeBroker();
    const candleTime = Date.UTC(2026, 10, 18, 12);
    const signalTime = candleTime + hourMs;
    const first = connectToPostgres(testDatabase);
    let original!: OrderIntent;
    try {
      await migrateDatabase(first.db);
      const sandbox = new SandboxConnection(
        new PostgresSandboxConnection(first.db),
        cipher,
        sandboxBroker,
      );
      await sandbox.connect(token);
      await sandbox.selectAccount('existing');
      const strategy = new StrategySettings(
        new PostgresStrategySettings(first.db, await ensureAppOwner(first.db)),
        sandbox,
      );
      await strategy.search('IMOEXF');
      await strategy.save({
        accountId: 'existing',
        instrumentUid: 'contract-a',
        emaPeriod: 34,
        lots: 2,
        timeframe: '1h',
      });
      original = {
        id: randomUUID(),
        accountId: 'existing',
        instrumentUid: 'contract-a',
        ticker: 'IMOEXF',
        context: {
          type: 'signal',
          candleTime,
          signalTime,
          strategy: { kind: 'surfing', signalPrice: 99, ema: 100 },
        },
        timeframe: '1h',
        direction: 'sell',
        fromPosition: 0,
        targetPosition: -2,
        lots: 2,
      };
      assert.equal(
        await new PostgresTradingStore(first.db, surfingJournalProjection).reserve(original),
        true,
      );
    } finally {
      await first.close();
    }

    const second = connectToPostgres(testDatabase);
    const sandbox = new SandboxConnection(
      new PostgresSandboxConnection(second.db),
      cipher,
      sandboxBroker,
    );
    const strategy = new StrategySettings(
      new PostgresStrategySettings(second.db, await ensureAppOwner(second.db)),
      sandbox,
    );
    const store = new PostgresTradingStore(second.db, surfingJournalProjection);
    let listener: ((update: MarketUpdate) => void) | undefined;
    let position = -2;
    let now = signalTime - 1; // Exercise the database guard even if a clock correction makes a replay look fresh.
    const submissions: OrderIntent[] = [];
    const lookups: [string, string | null][] = [];
    const broker: Broker = {
      async verifySelection() {},
      async accountState() {
        return { position, activeOrders: false };
      },
      async submit(_token, order) {
        submissions.push(order);
        position = order.targetPosition;
        return {
          brokerOrderId: 'new-exchange-id',
          brokerStatus: 'filled',
          executedLots: order.lots,
        };
      },
      async orderState(_token, order, id) {
        lookups.push([order.id, id]);
        return {
          brokerOrderId: id ?? 'recovered-exchange-id',
          brokerStatus: 'filled',
          executedLots: order.lots,
          executions: [
            { tradeId: 'fill', lots: order.lots, price: 98.5, time: signalTime + 3_000 },
          ],
        };
      },
    };
    const robot = new Robot(
      broker,
      store,
      {
        async subscribe(callback, config) {
          assert.equal(config?.emaPeriod, 34);
          listener = callback;
          listener({ stream: 'live' });
          return () => {
            listener = undefined;
          };
        },
      },
      async () => {
        const { settings } = await strategy.get();
        assert.ok(settings);
        return {
          ...(await sandbox.tradingCredentials()),
          instrumentUid: settings.instrument.uid,
          ticker: settings.instrument.ticker,
          emaPeriod: settings.parameters.emaPeriod,
          lots: settings.parameters.lots,
          timeframe: settings.timeframe,
        };
      },
      () => now,
      (history, options, config) => surfingStrategy.live(history, options, config),
    );
    const replay = (...closes: number[]) =>
      listener?.({
        stream: 'live',
        history: {
          instrumentUid: original.instrumentUid,
          emaPeriod: 34,
          timeframe: '1h',
          candles: closes.map((close, index) => ({
            time: candleTime + (index - 1) * hourMs,
            close,
            open: close,
            high: close,
            low: close,
            complete: true,
            confirmedEma: 100,
            previewEma: null,
          })),
        },
      });
    try {
      await robot.restore();
      assert.deepEqual(robot.status(), {
        mode: 'stopped',
        reason: null,
        position: -2,
        recovery: { orderId: original.id, ready: true },
      });
      assert.equal(listener, undefined);
      assert.equal(submissions.length, 0);
      assert.deepEqual(lookups, [[original.id, null]]);
      const [restored] = await robot.history(original.accountId);
      assert.equal(restored.id, original.id);
      assert.equal(restored.status, 'confirmed');
      assert.equal(restored.executions[0].price, 98.5);
      assert.equal((await strategy.get()).settings?.parameters.lots, 2);
      assert.equal(await store.reserve({ ...original, id: randomUUID() }), false);

      await robot.resume();
      now = signalTime;
      replay(99, 101); // A corrected replay would reverse the position if its reservation were not deduplicated.
      await setImmediate();
      await robot.shutdown();
      assert.equal(submissions.length, 0);
      assert.deepEqual(lookups, [[original.id, null]]);
      assert.equal((await robot.history(original.accountId)).length, 1);
    } finally {
      await robot.shutdown();
      await second.close();
    }
  },
);

test(
  'strategy migrations preserve legacy values and permit an empty installation',
  { skip: !testDatabase },
  async () => {
    const { readFile } = await import('node:fs/promises');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: testDatabase });
    await client.connect();
    try {
      for (const scenario of ['empty', 'legacy', 'interrupted', 'partial'] as const) {
        const name = `migration_${randomUUID().replaceAll('-', '')}`;
        await client.query(`CREATE SCHEMA "${name}"`);
        try {
          await client.query(`SET search_path TO "${name}"`);
          const old = await readFile(
            new URL('../../migrations/0002_strategy_settings.sql', import.meta.url),
            'utf8',
          );
          await client.query(old);
          await client.query(
            `ALTER TABLE strategy_settings ADD COLUMN timeframe text NOT NULL DEFAULT '1h'`,
          );
          if (scenario !== 'empty')
            await client.query(
              `INSERT INTO strategy_settings (id, instrument_uid, ticker, name, class_code, exchange, expiration_date, ema_period, lots, timeframe) VALUES (1, 'uid', 'T', 'name', 'class', 'exchange', '2030-01-01', 34, 7, '30m')`,
            );
          for (const file of ['0007_special_leper_queen.sql', '0008_mighty_lester.sql']) {
            const sql = await readFile(
              new URL(`../../migrations/${file}`, import.meta.url),
              'utf8',
            );
            for (const statement of sql.split('--> statement-breakpoint'))
              if (statement.trim()) await client.query(statement);
            // An earlier deployment may already have applied 0007 before it contained a backfill.
            if (file.startsWith('0007') && scenario === 'interrupted')
              await client.query('UPDATE strategy_settings SET kind = NULL, parameters = NULL');
            if (file.startsWith('0007') && scenario === 'partial')
              await client.query('UPDATE strategy_settings SET parameters = NULL');
          }
          const rows = (await client.query('SELECT * FROM strategy_settings')).rows;
          if (scenario === 'empty') assert.equal(rows.length, 0);
          else {
            assert.equal(rows[0].kind, 'surfing');
            assert.deepEqual(rows[0].parameters, { emaPeriod: 34, lots: 7 });
            assert.equal(rows[0].instrument_uid, 'uid');
            assert.equal(rows[0].timeframe, '30m');
          }
        } finally {
          await client.query('SET search_path TO public');
          await client.query(`DROP SCHEMA "${name}" CASCADE`);
        }
      }
    } finally {
      await client.end();
    }
  },
);

test('unknown or corrupt stored strategy cannot be loaded', { skip: !testDatabase }, async () => {
  const connection = connectToPostgres(testDatabase);
  try {
    await migrateDatabase(connection.db);
    const store = new PostgresStrategySettings(connection.db, await ensureAppOwner(connection.db));
    await connection.db.$client.query(
      `INSERT INTO strategy_profiles (app_account_id, instrument_uid, ticker, name, class_code, exchange, kind, parameters, timeframe) VALUES ((SELECT app_account_id FROM app_owner WHERE id = 1), 'uid', 'T', 'name', 'class', 'exchange', 'surfing', '{"emaPeriod":0,"lots":1}', '1h') ON CONFLICT (app_account_id, kind) DO UPDATE SET kind = EXCLUDED.kind, parameters = EXCLUDED.parameters`,
    );
    await assert.rejects(store.load(), /Invalid saved strategy/);
    await connection.db.$client.query(
      `UPDATE strategy_profiles SET kind = 'surfing', parameters = '{"emaPeriod":55,"lots":0}' WHERE kind = 'surfing'`,
    );
    await assert.rejects(store.load(), /Invalid saved strategy/);
    await connection.db.$client.query(
      `UPDATE strategy_profiles SET parameters = '{"emaPeriod":55,"lots":1,"instrument":{"uid":"attacker"},"kind":"unknown"}' WHERE kind = 'surfing'`,
    );
    await assert.rejects(store.load(), /Invalid saved strategy/);
    let touched = false;
    const broker: Broker = {
      async verifySelection() {
        touched = true;
      },
      async accountState() {
        touched = true;
        return { position: 0, activeOrders: false };
      },
      async submit() {
        touched = true;
        throw new Error('unexpected submit');
      },
      async orderState() {
        touched = true;
        throw new Error('unexpected lookup');
      },
    };
    const robot = new Robot(
      broker,
      new PostgresTradingStore(connection.db, surfingJournalProjection),
      {
        async subscribe() {
          touched = true;
          return () => {};
        },
      },
      async () => {
        const saved = await store.load();
        assert.ok(saved);
        return {
          token: 'token',
          accountId: 'account',
          instrumentUid: saved.instrument.uid,
          ticker: saved.instrument.ticker,
          emaPeriod: saved.parameters.emaPeriod,
          lots: saved.parameters.lots,
          timeframe: saved.timeframe,
        };
      },
      Date.now,
      (history, options, config) => surfingStrategy.live(history, options, config),
    );
    await assert.rejects(robot.start(), /Invalid saved strategy/);
    assert.equal(touched, false);
  } finally {
    await connection.db.$client.query('DELETE FROM strategy_profiles');
    await connection.close();
  }
});

test(
  'startup migrator installs the complete schema on an empty database',
  {
    skip:
      !process.env.SERFING_MIGRATION_ADMIN_DATABASE_URL &&
      'Requires a disposable PostgreSQL admin connection with CREATEDB',
  },
  async () => {
    const { Client } = await import('pg');
    const adminUrl = process.env.SERFING_MIGRATION_ADMIN_DATABASE_URL!;
    const admin = new Client({ connectionString: adminUrl });
    const name = `migration_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      const connection = connectToPostgres(url.toString());
      try {
        await migrateDatabase(connection.db);
        assert.equal(
          await new PostgresStrategySettings(
            connection.db,
            await ensureAppOwner(connection.db),
          ).load(),
          null,
        );
        assert.deepEqual(
          await new PostgresTradingStore(connection.db, surfingJournalProjection).history(),
          [],
        );
        const migrations = await connection.db.$client.query(
          'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
        );
        assert.equal(migrations.rows[0].count, 11);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  },
);

test(
  'startup migrator upgrades a 0006 database with settings and a reserved order',
  {
    skip:
      !process.env.SERFING_MIGRATION_ADMIN_DATABASE_URL &&
      'Requires a disposable PostgreSQL admin connection with CREATEDB',
  },
  async () => {
    const { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Client } = await import('pg');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const adminUrl = process.env.SERFING_MIGRATION_ADMIN_DATABASE_URL!;
    const admin = new Client({ connectionString: adminUrl });
    const name = `migration_${randomUUID().replaceAll('-', '')}`;
    const folder = await mkdtemp(join(tmpdir(), 'fazan-migration-'));
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      const connection = connectToPostgres(url.toString());
      try {
        const root = new URL('../../migrations/', import.meta.url);
        const journal = JSON.parse(await readFile(new URL('meta/_journal.json', root), 'utf8')) as {
          entries: Array<{ idx: number; tag: string }>;
        };
        journal.entries = journal.entries.filter((entry) => entry.idx <= 6);
        await mkdir(join(folder, 'meta'));
        await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
        for (const entry of journal.entries)
          await copyFile(new URL(`${entry.tag}.sql`, root), join(folder, `${entry.tag}.sql`));
        await migrate(connection.db, { migrationsFolder: folder });
        await connection.db.$client.query(
          `INSERT INTO strategy_settings (id, instrument_uid, ticker, name, class_code, exchange, expiration_date, ema_period, lots, timeframe) VALUES (1, 'uid', 'T', 'name', 'class', 'exchange', '2030-01-01', 34, 7, '30m')`,
        );
        await connection.db.$client.query(
          `INSERT INTO trade_orders (id, account_id, instrument_uid, ticker, candle_time_ms, signal_time_ms, signal_price, ema, direction, lots, from_position, target_position, status, broker_status, timeframe) VALUES ('original-id', 'account', 'uid', 'T', 1000, 2000, 101, 100, 'buy', 7, 0, 7, 'reserved', 'unknown', '30m')`,
        );
        await migrateDatabase(connection.db);
        const upgradedStore = new PostgresStrategySettings(
          connection.db,
          await ensureAppOwner(connection.db),
        );
        assert.equal(await upgradedStore.load(), null);
        const trading = new PostgresTradingStore(connection.db, surfingJournalProjection);
        let submissions = 0;
        let lookups = 0;
        const robot = new Robot(
          {
            async verifySelection() {},
            async accountState() {
              return { position: 0, activeOrders: false };
            },
            async submit() {
              submissions++;
              throw new Error('unexpected submission');
            },
            async orderState() {
              lookups++;
              throw new Error('unavailable');
            },
          },
          trading,
          {
            async subscribe() {
              assert.fail('Unexpected automatic run');
            },
          },
          async () => {
            const saved = await upgradedStore.load();
            if (!saved) throw new Error('missing settings');
            return {
              accountId: 'account',
              token: 'token',
              instrumentUid: saved.instrument.uid,
              ticker: saved.instrument.ticker,
              timeframe: saved.timeframe,
            };
          },
          Date.now,
          () => undefined,
          async (order) => ({
            accountId: order.accountId,
            token: 'token',
            instrumentUid: order.instrumentUid,
          }),
        );
        await robot.restore();
        assert.equal(robot.status().recovery?.orderId, 'original-id');
        const profile = {
          instrument: {
            uid: 'other',
            ticker: 'O',
            name: 'other',
            classCode: 'class',
            exchange: 'exchange',
            expirationDate: null,
          },
          kind: 'surfing' as const,
          parameters: { emaPeriod: 55, lots: 1 },
          timeframe: '1h' as const,
        };
        await assert.rejects(upgradedStore.save(profile), /STRATEGY_LEGACY_CLAIM_REQUIRED/);
        await connection.db.$client.query(
          `INSERT INTO strategy_profiles (app_account_id, instrument_uid, ticker, name, class_code, exchange, kind, parameters, timeframe)
           SELECT app_account_id, 'other', 'O', 'other', 'class', 'exchange', 'surfing', '{"emaPeriod":55,"lots":1}', '1h' FROM app_owner`,
        );
        await assert.rejects(upgradedStore.claimLegacy(), /STRATEGY_PROFILE_EXISTS/);
        assert.equal((await upgradedStore.load())?.instrument.uid, 'other');
        assert.equal(
          (await connection.db.$client.query('SELECT * FROM legacy_strategy_claim')).rowCount,
          0,
        );
        await connection.db.$client.query('DELETE FROM strategy_profiles');
        const originalLegacy = (
          await connection.db.$client.query('SELECT * FROM strategy_settings')
        ).rows;
        for (const [kind, parameters] of [
          ['unknown', '{"emaPeriod":34,"lots":7}'],
          ['surfing', '{"emaPeriod":0,"lots":7}'],
          ['surfing', '{"emaPeriod":34,"lots":"7"}'],
        ]) {
          await connection.db.$client.query(
            'UPDATE strategy_settings SET kind = $1, parameters = $2::jsonb',
            [kind, parameters],
          );
          const invalidLegacy = (
            await connection.db.$client.query('SELECT * FROM strategy_settings')
          ).rows;
          await assert.rejects(upgradedStore.claimLegacy(), /Invalid legacy strategy settings/);
          assert.deepEqual(
            (await connection.db.$client.query('SELECT * FROM strategy_settings')).rows,
            invalidLegacy,
          );
          assert.equal(
            (await connection.db.$client.query('SELECT * FROM strategy_profiles')).rowCount,
            0,
          );
          assert.equal(
            (await connection.db.$client.query('SELECT * FROM legacy_strategy_claim')).rowCount,
            0,
          );
        }
        await connection.db.$client.query(
          `UPDATE strategy_settings SET kind = 'surfing', parameters = '{"emaPeriod":34,"lots":7}'`,
        );
        await connection.db.$client.query(`
          CREATE FUNCTION fail_legacy_marker() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM strategy_profiles WHERE app_account_id = NEW.app_account_id) THEN
              RAISE EXCEPTION 'marker insertion failed after profile insertion';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER fail_legacy_marker BEFORE INSERT ON legacy_strategy_claim
          FOR EACH ROW EXECUTE FUNCTION fail_legacy_marker();
        `);
        await assert.rejects(upgradedStore.claimLegacy());
        assert.equal(
          (await connection.db.$client.query('SELECT * FROM strategy_profiles')).rowCount,
          0,
        );
        assert.equal(
          (await connection.db.$client.query('SELECT * FROM legacy_strategy_claim')).rowCount,
          0,
        );
        assert.deepEqual(
          (await connection.db.$client.query('SELECT * FROM strategy_settings')).rows,
          originalLegacy,
        );
        await connection.db.$client.query(`
          DROP TRIGGER fail_legacy_marker ON legacy_strategy_claim;
          DROP FUNCTION fail_legacy_marker();
        `);
        const claims = await Promise.allSettled([
          robot.claimLegacySettings(() => upgradedStore.claimLegacy()),
          upgradedStore.claimLegacy(),
        ]);
        assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 2);
        assert.equal(
          (await connection.db.$client.query('SELECT * FROM strategy_settings')).rowCount,
          1,
        );
        assert.equal(robot.status().recovery?.orderId, 'original-id');
        const initialLookups = lookups;
        await robot.reconcile();
        assert.equal(lookups, initialLookups + 1);
        assert.equal(submissions, 0);
        const saved = await upgradedStore.load();
        assert.deepEqual(saved?.parameters, { emaPeriod: 34, lots: 7 });
        assert.equal(saved?.instrument.uid, 'uid');
        assert.equal(saved?.timeframe, '30m');
        await upgradedStore.save(profile);
        await upgradedStore.claimLegacy();
        assert.deepEqual(await upgradedStore.load(), profile);
        await assert.rejects(
          new PostgresStrategySettings(connection.db, 'different-owner').claimLegacy(),
          /STRATEGY_LEGACY_NOT_PENDING/,
        );
        const reserved = await trading.unresolved();
        assert.equal(reserved?.id, 'original-id');
        assert.equal(reserved?.status, 'unconfirmed');
        const entries = await trading.history('account');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, 'original-id');
        assert.equal(entries[0].signalPrice, 101);
        assert.equal(entries[0].ema, 100);
        assert.equal(
          reserved && (await trading.reserve({ ...reserved, id: 'different-id' })),
          false,
        );
        const journalRows = await connection.db.$client.query(
          'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
        );
        assert.equal(journalRows.rows[0].count, 11);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
