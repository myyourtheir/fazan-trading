import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const ownerSessions = pgTable('owner_sessions', {
  tokenDigest: text('token_digest').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [
  index('owner_sessions_expiry').on(table.expiresAt),
]);

export const sandboxConnection = pgTable('sandbox_connection', {
  id: integer('id').primaryKey(),
  encryptedToken: text('encrypted_token').notNull(),
  accountId: text('account_id'),
}, table => [
  check('sandbox_connection_singleton', sql`${table.id} = 1`),
]);
