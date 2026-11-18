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

export const strategySettings = pgTable('strategy_settings', {
  id: integer('id').primaryKey(),
  uid: text('instrument_uid').notNull(),
  ticker: text('ticker').notNull(),
  name: text('name').notNull(),
  classCode: text('class_code').notNull(),
  exchange: text('exchange').notNull(),
  expirationDate: text('expiration_date'),
  emaPeriod: integer('ema_period').notNull(),
  lots: integer('lots').notNull(),
}, table => [
  check('strategy_settings_singleton', sql`${table.id} = 1`),
  check('strategy_settings_positive_ema', sql`${table.emaPeriod} > 0`),
  check('strategy_settings_positive_lots', sql`${table.lots} > 0`),
]);
