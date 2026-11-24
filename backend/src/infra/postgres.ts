import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { SessionStore } from '../core/auth.js';
import type { DisplaySettingsStore } from '../core/display-settings.js';
import type { SandboxStore, SavedSandboxConnection } from '../core/sandbox.js';
import {
  StrategySettingsError,
  type SavedStrategy,
  type StrategyStore,
  type SavedImprovedStrategy,
  type StrategyKind,
  validImproved,
  isStrategyKind,
} from '../core/strategy-settings.js';
import { surfingStrategy } from '../core/surfing-strategy.js';
import { isTimeframe } from '../core/timeframe.js';
import {
  RobotError,
  type OrderIntent,
  type OrderResult,
  type RecoveredOrder,
  type TradingStore,
} from '../core/robot.js';
import type { JournalEntry } from '../core/journal.js';
import {
  ProtectionLedger,
  protectionLedgerAccount,
  protectionLedgerBlocksTrading,
} from '../core/protection-ledger.js';
import * as schema from './db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations/', import.meta.url));
const {
  ownerSessions,
  displaySettings,
  sandboxConnection,
  strategySettings,
  appOwner,
  strategyProfiles,
  legacyStrategyClaim,
  strategySelection,
  tradeOrders,
  tradeExecutions,
  protectionLedger,
} = schema;
type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// All reservations use this lock, including writes by the legacy Surfing journal.
async function lockProtectionLedger(tx: Transaction) {
  const [ledger] = await tx
    .select()
    .from(protectionLedger)
    .where(eq(protectionLedger.id, 1))
    .for('update');
  if (!ledger) throw new Error('Trading guard unavailable');
  return ledger.state;
}

async function readProtectionLedger(db: Database) {
  const [ledger] = await db.select().from(protectionLedger).where(eq(protectionLedger.id, 1));
  if (!ledger) throw new Error('Trading guard unavailable');
  return ledger.state;
}

async function requireUnlockedSettings(tx: Transaction) {
  if (protectionLedgerBlocksTrading(await lockProtectionLedger(tx)))
    throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
}

export function connectToPostgres(connectionString: string | undefined) {
  const db = drizzle({ connection: { connectionString, connectionTimeoutMillis: 5_000 }, schema });
  db.$client.on('error', () => console.error('An idle PostgreSQL connection failed.'));
  return { db, close: () => db.$client.end() };
}

export function migrateDatabase(db: Database) {
  return migrate(db, { migrationsFolder });
}

export async function ensureAppOwner(db: Database) {
  await db.insert(appOwner).values({ id: 1, appAccountId: randomUUID() }).onConflictDoNothing();
  const [owner] = await db.select().from(appOwner).where(eq(appOwner.id, 1));
  if (!owner) throw new Error('Application owner unavailable');
  await db
    .insert(strategySelection)
    .values({ appAccountId: owner.appAccountId })
    .onConflictDoNothing();
  return owner.appAccountId;
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
    const { encryptedToken, accountId, previousAccountId, previousEncryptedToken } =
      sandboxConnection;
    const [saved] = await this.db
      .select({ encryptedToken, accountId, previousAccountId, previousEncryptedToken })
      .from(sandboxConnection)
      .where(eq(sandboxConnection.id, 1));
    return saved ?? null;
  }

  public async save(connection: SavedSandboxConnection) {
    await this.db.transaction(async (tx) => {
      const pinnedAccount = protectionLedgerAccount(await lockProtectionLedger(tx));
      if (pinnedAccount !== undefined && pinnedAccount !== connection.accountId)
        throw new RobotError('ROBOT_PROTECTION_UNRESOLVED');
      await tx
        .insert(sandboxConnection)
        .values({ id: 1, ...connection })
        .onConflictDoUpdate({ target: sandboxConnection.id, set: connection });
    });
  }
}

export class PostgresStrategySettings implements StrategyStore {
  constructor(
    private readonly db: Database,
    private readonly appAccountId: string,
  ) {}

  public async load() {
    const [saved] = await this.db
      .select()
      .from(strategyProfiles)
      .where(
        and(
          eq(strategyProfiles.appAccountId, this.appAccountId),
          eq(strategyProfiles.kind, 'surfing'),
        ),
      );
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
    await this.db.transaction(async (tx) => {
      await requireUnlockedSettings(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(1936028243)`);
      const [legacy] = await tx.select().from(strategySettings).where(eq(strategySettings.id, 1));
      const [claim] = await tx
        .select()
        .from(legacyStrategyClaim)
        .where(eq(legacyStrategyClaim.id, 1));
      if (legacy && !claim) throw new StrategySettingsError('STRATEGY_LEGACY_CLAIM_REQUIRED');
      await tx
        .insert(strategyProfiles)
        .values({ appAccountId: this.appAccountId, ...values })
        .onConflictDoUpdate({
          target: [strategyProfiles.appAccountId, strategyProfiles.kind],
          set: values,
        });
    });
  }

  public async loadImproved(): Promise<SavedImprovedStrategy | null> {
    const [saved] = await this.db
      .select()
      .from(strategyProfiles)
      .where(
        and(
          eq(strategyProfiles.appAccountId, this.appAccountId),
          eq(strategyProfiles.kind, 'improved-surfing'),
        ),
      );
    if (!saved) return null;
    const { uid, ticker, name, classCode, exchange, expirationDate, parameters, timeframe } = saved;
    if (!validImproved(parameters) || !isTimeframe(timeframe))
      throw new Error('Invalid saved strategy settings');
    return {
      instrument: { uid, ticker, name, classCode, exchange, expirationDate },
      kind: 'improved-surfing',
      parameters,
      timeframe,
    };
  }

  public async saveImproved({ instrument, kind, parameters, timeframe }: SavedImprovedStrategy) {
    if (kind !== 'improved-surfing' || !validImproved(parameters) || !isTimeframe(timeframe))
      throw new Error('Invalid strategy settings');
    const values = { ...instrument, kind, parameters, timeframe };
    await this.db.transaction(async (tx) => {
      await requireUnlockedSettings(tx);
      await tx
        .insert(strategyProfiles)
        .values({ appAccountId: this.appAccountId, ...values })
        .onConflictDoUpdate({
          target: [strategyProfiles.appAccountId, strategyProfiles.kind],
          set: values,
        });
    });
  }

  public async selected(): Promise<StrategyKind> {
    const [row] = await this.db
      .select()
      .from(strategySelection)
      .where(eq(strategySelection.appAccountId, this.appAccountId));
    if (!row) return 'surfing';
    if (!isStrategyKind(row.kind)) throw new Error('Invalid strategy selection');
    return row.kind;
  }

  public async select(kind: StrategyKind) {
    if (!isStrategyKind(kind)) throw new Error('Invalid strategy selection');
    await this.db.transaction(async (tx) => {
      await requireUnlockedSettings(tx);
      await tx
        .insert(strategySelection)
        .values({ appAccountId: this.appAccountId, kind })
        .onConflictDoUpdate({ target: strategySelection.appAccountId, set: { kind } });
    });
  }

  public async legacyClaimAvailable() {
    const [legacy] = await this.db
      .select()
      .from(strategySettings)
      .where(eq(strategySettings.id, 1));
    const [claim] = await this.db
      .select()
      .from(legacyStrategyClaim)
      .where(eq(legacyStrategyClaim.id, 1));
    const profile = await this.load();
    return Boolean(legacy && !claim && !profile);
  }

  public async claimLegacy() {
    await this.db.transaction(async (tx) => {
      await requireUnlockedSettings(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(1936028243)`);
      const [legacy] = await tx.select().from(strategySettings).where(eq(strategySettings.id, 1));
      const [claimed] = await tx
        .select()
        .from(legacyStrategyClaim)
        .where(eq(legacyStrategyClaim.id, 1));
      if (claimed?.appAccountId === this.appAccountId) return;
      if (!legacy || claimed) throw new StrategySettingsError('STRATEGY_LEGACY_NOT_PENDING');
      if (
        legacy.kind !== surfingStrategy.kind ||
        !surfingStrategy.validate(legacy.parameters) ||
        !isTimeframe(legacy.timeframe)
      )
        throw new Error('Invalid legacy strategy settings');
      const { id: _id, ...values } = legacy;
      const inserted = await tx
        .insert(strategyProfiles)
        .values({ ...values, appAccountId: this.appAccountId })
        .onConflictDoNothing()
        .returning({ kind: strategyProfiles.kind });
      if (!inserted.length) throw new StrategySettingsError('STRATEGY_PROFILE_EXISTS');
      await tx.insert(legacyStrategyClaim).values({ id: 1, appAccountId: this.appAccountId });
    });
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
    return this.db.transaction(async (tx) => {
      const ledger = await lockProtectionLedger(tx);
      if (protectionLedgerBlocksTrading(ledger) || Object.hasOwn(ledger.orders, order.id))
        return false;
      const rows = await tx
        .insert(tradeOrders)
        .values({
          ...this.projection.toJournalIntent(order),
          status: 'reserved',
          brokerStatus: 'unknown',
        })
        .onConflictDoNothing()
        .returning({ id: tradeOrders.id });
      return rows.length === 1;
    });
  }

  public async record(id: string, { executions, ...result }: OrderResult) {
    await this.db.transaction(async (tx) => {
      const ledger = await lockProtectionLedger(tx);
      if (result.status === 'unconfirmed' && protectionLedgerBlocksTrading(ledger))
        throw new Error('Protected trading guard active');
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
    if (protectionLedgerBlocksTrading(await readProtectionLedger(this.db))) return true;
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

  public async recoveredOrder(id: string) {
    const [order] = await this.readJournal(eq(tradeOrders.id, id));
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

/** Durable guarded journal. The production strategy gate does not instantiate the Improved Robot. */
export class PostgresProtectionStore extends ProtectionLedger {
  public constructor(
    db: Database,
    private readonly legacy: PostgresTradingStore,
  ) {
    super({
      read: () => readProtectionLedger(db),
      write: (transition) =>
        db.transaction(async (tx) => {
          const ledger = await lockProtectionLedger(tx);
          const [unresolved] = await tx
            .select({ id: tradeOrders.id })
            .from(tradeOrders)
            .where(unresolvedOrders())
            .limit(1);
          if (unresolved) return { ok: false, reason: 'order-conflict' };
          const originalIds = new Set(Object.keys(ledger.orders));
          const result = transition(ledger);
          if (!result.ok) return result;
          const added = Object.keys(ledger.orders).filter((id) => !originalIds.has(id));
          if (added.length) {
            const [duplicate] = await tx
              .select({ id: tradeOrders.id })
              .from(tradeOrders)
              .where(inArray(tradeOrders.id, added))
              .limit(1);
            if (duplicate) return { ok: false, reason: 'order-conflict' };
          }
          await tx
            .update(protectionLedger)
            .set({ state: ledger })
            .where(eq(protectionLedger.id, 1));
          return result;
        }),
    });
  }

  public override async hasUnresolved() {
    return (await super.hasUnresolved()) || (await this.legacy.unresolved()) !== null;
  }

  public override async unresolved() {
    return (await super.unresolved()) ?? this.legacy.unresolved();
  }

  public override async record(id: string, result: OrderResult) {
    if (await this.legacy.recoveredOrder(id)) return this.legacy.record(id, result);
    return super.record(id, result);
  }
}
