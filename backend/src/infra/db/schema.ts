import { sql } from 'drizzle-orm';
import { bigint, check, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BrokerOrder, JournalEntry, OrderIntent } from '../../core/robot.js';
import { defaultTimeframe, type Timeframe } from '../../core/timeframe.js';

export const ownerSessions = pgTable('owner_sessions', {
  tokenDigest: text('token_digest').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [
  index('owner_sessions_expiry').on(table.expiresAt),
]);

export const displaySettings = pgTable('display_settings', {
  id: integer('id').primaryKey(),
  timeZone: text('time_zone').notNull(),
}, table => [
  check('display_settings_singleton', sql`${table.id} = 1`),
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
  timeframe: text('timeframe').$type<Timeframe>().notNull().default(defaultTimeframe),
  lots: integer('lots').notNull(),
}, table => [
  check('strategy_settings_singleton', sql`${table.id} = 1`),
  check('strategy_settings_positive_ema', sql`${table.emaPeriod} > 0`),
  check('strategy_settings_positive_lots', sql`${table.lots} > 0`),
  check('strategy_settings_valid_timeframe', sql`${table.timeframe} in ('5m', '15m', '30m', '1h')`),
]);

export const tradeOrders = pgTable('trade_orders', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  instrumentUid: text('instrument_uid').notNull(),
  ticker: text('ticker').notNull(),
  action: text('action').$type<OrderIntent['action']>().notNull().default('ema-crossing'),
  timeframe: text('timeframe').$type<Timeframe>().notNull().default(defaultTimeframe),
  candleTime: bigint('candle_time_ms', { mode: 'number' }),
  signalTime: bigint('signal_time_ms', { mode: 'number' }),
  signalPrice: doublePrecision('signal_price'),
  ema: doublePrecision('ema'),
  manualCloseTime: bigint('manual_close_time_ms', { mode: 'number' }),
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
  uniqueIndex('trade_orders_candle').on(table.accountId, table.instrumentUid, table.timeframe, table.candleTime),
  check('trade_orders_valid_timeframe', sql`${table.timeframe} in ('5m', '15m', '30m', '1h')`),
  uniqueIndex('trade_orders_single_unresolved').on(sql`(true)`).where(sql`${table.status} in ('reserved', 'unconfirmed')`),
  check('trade_orders_action_context', sql`(
    ${table.action} = 'ema-crossing' and ${table.candleTime} is not null and ${table.signalTime} is not null
      and ${table.signalPrice} is not null and ${table.ema} is not null and ${table.manualCloseTime} is null
  ) or (
    ${table.action} = 'manual-close' and ${table.candleTime} is null and ${table.signalTime} is null
      and ${table.signalPrice} is null and ${table.ema} is null and ${table.manualCloseTime} is not null
      and ${table.targetPosition} = 0
  )`),
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
