import { sql } from 'drizzle-orm';
import { bigint, check, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BrokerOrder, JournalEntry, OrderIntent } from '../robot.js';

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

export const tradeOrders = pgTable('trade_orders', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  instrumentUid: text('instrument_uid').notNull(),
  ticker: text('ticker').notNull(),
  candleTime: bigint('candle_time_ms', { mode: 'number' }).notNull(),
  signalTime: bigint('signal_time_ms', { mode: 'number' }).notNull(),
  signalPrice: doublePrecision('signal_price').notNull(),
  ema: doublePrecision('ema').notNull(),
  direction: text('direction').$type<OrderIntent['direction']>().notNull(),
  lots: integer('lots').notNull(),
  fromPosition: integer('from_position').notNull(),
  targetPosition: integer('target_position').notNull(),
  status: text('status').$type<JournalEntry['status']>().notNull(),
  brokerOrderId: text('broker_order_id'),
  brokerStatus: text('broker_status').$type<BrokerOrder['brokerStatus']>().notNull(),
  executedLots: integer('executed_lots'),
  position: integer('position'),
}, table => [
  uniqueIndex('trade_orders_candle').on(table.accountId, table.instrumentUid, table.candleTime),
  uniqueIndex('trade_orders_single_unresolved').on(sql`(true)`).where(sql`${table.status} in ('reserved', 'unconfirmed')`),
]);

export const tradeExecutions = pgTable('trade_executions', {
  orderId: text('order_id').notNull().references(() => tradeOrders.id),
  sequence: integer('sequence').notNull(),
  tradeId: text('trade_id').notNull(),
  lots: integer('lots').notNull(),
  price: doublePrecision('price'),
  time: bigint('execution_time_ms', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.orderId, table.sequence] }),
]);
