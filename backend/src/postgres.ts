import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { SessionStore } from './auth.js';

const migrations = ['001-owner-sessions.sql'];
// Every backend version must use the same lock while applying migrations.
const migrationLockKey = 327491208;

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLockKey]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of migrations) {
      const result = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (result.rowCount) continue;
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresSessions implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(digest: string, expiresAt: Date) {
    await this.pool.query('DELETE FROM owner_sessions WHERE expires_at <= now()');
    await this.pool.query('INSERT INTO owner_sessions (token_digest, expires_at) VALUES ($1, $2)', [digest, expiresAt]);
  }

  async activeUntil(digest: string, at: Date) {
    const result = await this.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM owner_sessions WHERE token_digest = $1 AND expires_at > $2', [digest, at],
    );
    return result.rows[0]?.expires_at ?? null;
  }

  async revoke(digest: string) {
    await this.pool.query('DELETE FROM owner_sessions WHERE token_digest = $1', [digest]);
  }
}
