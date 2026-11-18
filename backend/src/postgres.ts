import { fileURLToPath } from 'node:url';
import { and, eq, gt, lte } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { SessionStore } from './auth.js';
import * as schema from './db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const { ownerSessions } = schema;
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
