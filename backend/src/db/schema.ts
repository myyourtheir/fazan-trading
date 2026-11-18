import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const ownerSessions = pgTable('owner_sessions', {
  tokenDigest: text('token_digest').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [
  index('owner_sessions_expiry').on(table.expiresAt),
]);
