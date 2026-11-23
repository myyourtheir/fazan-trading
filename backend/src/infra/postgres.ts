import { fileURLToPath } from 'node:url';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { SessionStore } from '../core/auth.js';
import type { DisplaySettingsStore } from '../core/display-settings.js';
import type { SandboxStore, SavedSandboxConnection } from '../core/sandbox.js';
import type { SavedStrategy, StrategyStore } from '../core/strategy-settings.js';
import { surfingStrategy } from '../core/surfing-strategy.js';
import { isTimeframe } from '../core/timeframe.js';
import type { OrderIntent, OrderResult, RecoveredOrder, TradingStore } from '../core/robot.js';
import type { JournalEntry } from '../core/journal.js';
import * as schema from './db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations/', import.meta.url));
const {
  ownerSessions,
  displaySettings,
  sandboxConnection,
  strategySettings,
  tradeOrders,
  tradeExecutions,
} = schema;
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

  public async create(digest: string, expiresAt: Date) {
    await this.db.transaction(async (tx) => {
      await tx.delete(ownerSessions).where(lte(ownerSessions.expiresAt, new Date()));
      await tx.insert(ownerSessions).values({ tokenDigest: digest, expiresAt });
    });
  }

  public async activeUntil(digest: string, at: Date) {
    const [session] = await this.db
      .select({ expiresAt: ownerSessions.expiresAt })
      .from(ownerSessions)
      .where(and(eq(ownerSessions.tokenDigest, digest), gt(ownerSessions.expiresAt, at)));
    return session?.expiresAt ?? null;
  }

  public async revoke(digest: string) {
    await this.db.delete(ownerSessions).where(eq(ownerSessions.tokenDigest, digest));
  }
}

export class PostgresDisplaySettings implements DisplaySettingsStore {
  constructor(private readonly db: Database) {}

  public async loadTimeZone() {
    const [saved] = await this.db
      .select({ timeZone: displaySettings.timeZone })
      .from(displaySettings)
      .where(eq(displaySettings.id, 1));
    return saved?.timeZone ?? null;
  }

  public async saveTimeZone(timeZone: string) {
    await this.db
      .insert(displaySettings)
      .values({ id: 1, timeZone })
      .onConflictDoUpdate({ target: displaySettings.id, set: { timeZone } });
  }
}

export class PostgresSandboxConnection implements SandboxStore {
  constructor(private readonly db: Database) {}

  public async load() {
    const { encryptedToken, accountId } = sandboxConnection;
    const [saved] = await this.db
      .select({ encryptedToken, accountId })
      .from(sandboxConnection)
      .where(eq(sandboxConnection.id, 1));
    return saved ?? null;
  }

  public async save(connection: SavedSandboxConnection) {
    await this.db
      .insert(sandboxConnection)
      .values({ id: 1, ...connection })
      .onConflictDoUpdate({ target: sandboxConnection.id, set: connection });
  }
}

export class PostgresStrategySettings implements StrategyStore {
  constructor(private readonly db: Database) {}

  public async load() {
    const [saved] = await this.db.select().from(strategySettings).where(eq(strategySettings.id, 1));
    if (!saved) return null;
    const { uid, ticker, name, classCode, exchange, expirationDate, kind, parameters, timeframe } =
      saved;
    if (
      kind !== surfingStrategy.kind ||
      !surfingStrategy.validate(parameters) ||
      !isTimeframe(timeframe)
    ) {
      throw new Error('Invalid saved strategy settings');
    }
    return {
      instrument: { uid, ticker, name, classCode, exchange, expirationDate },
      kind,
      parameters: { emaPeriod: parameters.emaPeriod, lots: parameters.lots },
      timeframe,
    };
  }

  public async save({ instrument, kind, parameters, timeframe }: SavedStrategy) {
    if (
      kind !== surfingStrategy.kind ||
      !surfingStrategy.validate(parameters) ||
      !isTimeframe(timeframe)
    )
      throw new Error('Invalid strategy settings');
    const values = { ...instrument, kind: surfingStrategy.kind, parameters, timeframe };
    await this.db
      .insert(strategySettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: strategySettings.id, set: values });
  }
}

const unresolvedOrders = () => inArray(tradeOrders.status, ['reserved', 'unconfirmed']);

export type JournalProjection = {
  toJournalIntent(order: OrderIntent): Omit<JournalEntry, keyof OrderResult | 'executions'>;
  toRecoveredOrder(entry: JournalEntry): RecoveredOrder;
};

export class PostgresTradingStore implements TradingStore<JournalEntry> {
  constructor(
    private readonly db: Database,
    private readonly projection: JournalProjection,
  ) {}

  public async reserve(order: OrderIntent) {
    const rows = await this.db
      .insert(tradeOrders)
      .values({
        ...this.projection.toJournalIntent(order),
        status: 'reserved',
        brokerStatus: 'unknown',
      })
      .onConflictDoNothing()
      .returning({ id: tradeOrders.id });
    return rows.length === 1;
  }

  public async record(id: string, { executions, ...result }: OrderResult) {
    await this.db.transaction(async (tx) => {
      await tx.update(tradeOrders).set(result).where(eq(tradeOrders.id, id));
      await tx.delete(tradeExecutions).where(eq(tradeExecutions.orderId, id));
      if (executions.length) {
        await tx
          .insert(tradeExecutions)
          .values(
            executions.map((execution, sequence) => ({ ...execution, orderId: id, sequence })),
          );
      }
    });
  }

  public async hasUnresolved() {
    const rows = await this.db
      .select({ id: tradeOrders.id })
      .from(tradeOrders)
      .where(unresolvedOrders())
      .limit(1);
    return rows.length > 0;
  }

  public async unresolved() {
    // The partial unique index allows at most one unresolved intent.
    const [order] = await this.readJournal(unresolvedOrders());
    return order ? this.projection.toRecoveredOrder(order) : null;
  }

  public history(accountId?: string) {
    return this.readJournal(
      accountId === undefined ? undefined : eq(tradeOrders.accountId, accountId),
    );
  }

  private async readJournal(filter?: ReturnType<typeof eq>) {
    const rows = await this.db
      .select()
      .from(tradeOrders)
      .leftJoin(tradeExecutions, eq(tradeOrders.id, tradeExecutions.orderId))
      .where(filter)
      .orderBy(
        desc(sql`coalesce(${tradeOrders.signalTime}, ${tradeOrders.manualCloseTime})`),
        tradeOrders.id,
        tradeExecutions.sequence,
      );
    const journal = new Map<string, JournalEntry>();
    for (const { trade_orders: order, trade_executions: execution } of rows) {
      const entry: JournalEntry = journal.get(order.id) ?? { ...order, executions: [] };
      journal.set(order.id, entry);
      if (execution) {
        const { tradeId, lots, price, time } = execution;
        entry.executions.push({ tradeId, lots, price, time });
      }
    }
    return [...journal.values()];
  }
}
