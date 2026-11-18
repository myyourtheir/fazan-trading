import { fileURLToPath } from 'node:url';
import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { SessionStore } from './auth.js';
import type { SandboxStore, SavedSandboxConnection } from './sandbox.js';
import type { SavedStrategy, StrategyStore } from './strategy-settings.js';
import type { OrderIntent, OrderResult, TradingStore } from './robot.js';
import * as schema from './db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const { ownerSessions, sandboxConnection, strategySettings, tradeOrders, tradeExecutions } = schema;
type Database = NodePgDatabase<typeof schema>;

export function connectToPostgres(connectionString: string | undefined) {
  const db = drizzle({ connection: { connectionString, connectionTimeoutMillis: 5_000 }, schema });
  db.$client.on('error', () => console.error('An idle PostgreSQL connection failed.'));
  return { db, close: () => db.$client.end() };
}

export function migrateDatabase(db: Database) {
  return migrate(db, { migrationsFolder });
}

export class PostgresSessions implements SessionStore {
  constructor(private readonly db: Database) {}

  async create(digest: string, expiresAt: Date) {
    await this.db.transaction(async tx => {
      await tx.delete(ownerSessions).where(lte(ownerSessions.expiresAt, new Date()));
      await tx.insert(ownerSessions).values({ tokenDigest: digest, expiresAt });
    });
  }

  async activeUntil(digest: string, at: Date) {
    const [session] = await this.db.select({ expiresAt: ownerSessions.expiresAt }).from(ownerSessions)
      .where(and(eq(ownerSessions.tokenDigest, digest), gt(ownerSessions.expiresAt, at)));
    return session?.expiresAt ?? null;
  }

  async revoke(digest: string) {
    await this.db.delete(ownerSessions).where(eq(ownerSessions.tokenDigest, digest));
  }
}

export class PostgresSandboxConnection implements SandboxStore {
  constructor(private readonly db: Database) {}

  async load() {
    const { encryptedToken, accountId } = sandboxConnection;
    const [saved] = await this.db.select({ encryptedToken, accountId }).from(sandboxConnection)
      .where(eq(sandboxConnection.id, 1));
    return saved ?? null;
  }

  async save(connection: SavedSandboxConnection) {
    await this.db.insert(sandboxConnection).values({ id: 1, ...connection })
      .onConflictDoUpdate({ target: sandboxConnection.id, set: connection });
  }
}

export class PostgresStrategySettings implements StrategyStore {
  constructor(private readonly db: Database) {}

  async load() {
    const [saved] = await this.db.select().from(strategySettings).where(eq(strategySettings.id, 1));
    if (!saved) return null;
    const { uid, ticker, name, classCode, exchange, expirationDate, emaPeriod, lots } = saved;
    return { instrument: { uid, ticker, name, classCode, exchange, expirationDate }, emaPeriod, lots };
  }

  async save({ instrument, emaPeriod, lots }: SavedStrategy) {
    const values = { ...instrument, emaPeriod, lots };
    await this.db.insert(strategySettings).values({ id: 1, ...values })
      .onConflictDoUpdate({ target: strategySettings.id, set: values });
  }
}

export class PostgresTradingStore implements TradingStore {
  constructor(private readonly db: Database) {}

  async reserve(order: OrderIntent) {
    const rows = await this.db.insert(tradeOrders).values({ ...order, status: 'reserved', brokerStatus: 'unknown' })
      .onConflictDoNothing().returning({ id: tradeOrders.id });
    return rows.length === 1;
  }

  async record(id: string, { executions, ...result }: OrderResult) {
    await this.db.transaction(async tx => {
      await tx.update(tradeOrders).set(result).where(eq(tradeOrders.id, id));
      await tx.delete(tradeExecutions).where(eq(tradeExecutions.orderId, id));
      if (executions.length) {
        await tx.insert(tradeExecutions).values(executions.map((execution, sequence) => ({ ...execution, orderId: id, sequence })));
      }
    });
  }

  async hasUnresolved() {
    const rows = await this.db.select({ id: tradeOrders.id }).from(tradeOrders)
      .where(inArray(tradeOrders.status, ['reserved', 'unconfirmed'])).limit(1);
    return rows.length > 0;
  }

  async history() {
    const rows = await this.db.select().from(tradeOrders).leftJoin(tradeExecutions, eq(tradeOrders.id, tradeExecutions.orderId))
      .orderBy(desc(tradeOrders.signalTime), tradeOrders.id, tradeExecutions.sequence);
    const journal = new Map<string, Awaited<ReturnType<TradingStore['history']>>[number]>();
    for (const { trade_orders: order, trade_executions: execution } of rows) {
      const entry = journal.get(order.id) ?? { ...order, executions: [] };
      journal.set(order.id, entry);
      if (execution) {
        const { tradeId, lots, price, time } = execution;
        entry.executions.push({ tradeId, lots, price, time });
      }
    }
    return [...journal.values()];
  }
}
