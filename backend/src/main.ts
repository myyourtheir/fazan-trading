import { once } from 'node:events';
import { createApp } from './app.js';
import { OwnerAuth } from './auth.js';
import { connectToPostgres, migrateDatabase, PostgresSessions } from './postgres.js';

async function main() {
  const { DATABASE_URL, PGHOST, OWNER_PASSWORD, COOKIE_SECURE = 'true', HOST = '127.0.0.1', PORT = '3000' } = process.env;
  if (!DATABASE_URL && !PGHOST) throw new Error('DATABASE_URL or PostgreSQL connection variables are required.');
  if (!OWNER_PASSWORD || OWNER_PASSWORD.length < 12 || OWNER_PASSWORD.length > 256) {
    throw new Error('OWNER_PASSWORD must contain 12–256 characters.');
  }
  if (!['true', 'false'].includes(COOKIE_SECURE)) throw new Error('COOKIE_SECURE must be true or false.');
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');

  const { db, close } = connectToPostgres(DATABASE_URL);
  try {
    await migrateDatabase(db);
    const auth = await OwnerAuth.create(OWNER_PASSWORD, new PostgresSessions(db));
    const server = createApp({ auth, secureCookies: COOKIE_SECURE === 'true' }).listen(port, HOST);
    await once(server, 'listening');
    console.log(`Serfing API is listening on ${HOST}:${port}.`);
    const shutdown = () => server.close(() => { void close(); });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    await close();
    throw new Error('Backend startup failed. Check the database connection, migrations, and listening address.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backend startup failed.');
  process.exitCode = 1;
});
