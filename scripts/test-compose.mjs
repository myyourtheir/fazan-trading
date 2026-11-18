import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = `fazan-trading-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const env = { ...process.env, OWNER_PASSWORD: password, POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  SANDBOX_TOKEN_KEY: randomBytes(32).toString('hex'), COOKIE_SECURE: 'false', FRONTEND_PORT: '0' };
const cwd = fileURLToPath(new URL('..', import.meta.url));
const compose = (...args) => execFileSync('docker', ['compose', '-p', project, ...args], {
  cwd, env, encoding: 'utf8', timeout: 180_000,
}).trim();
const headers = { 'Content-Type': 'application/json', 'X-Serfing-Request': '1' };
const sql = statement => compose('exec', '-T', 'postgres', 'psql', '-U', 'serfing', '-d', 'serfing',
  '-v', 'ON_ERROR_STOP=1', '-Atc', statement);
const migrations = () => sql('SELECT count(*) FROM drizzle.__drizzle_migrations');
const legacyToken = process.argv.includes('--legacy') ? randomBytes(32).toString('base64url') : null;

try {
  if (legacyToken) {
    const digest = createHash('sha256').update(legacyToken).digest('hex');
    compose('up', '--wait', 'postgres');
    sql(`
      CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE owner_sessions (token_digest text PRIMARY KEY, expires_at timestamptz NOT NULL);
      CREATE INDEX owner_sessions_expiry ON owner_sessions (expires_at);
      INSERT INTO schema_migrations (name) VALUES ('001-owner-sessions.sql');
      INSERT INTO owner_sessions (token_digest, expires_at) VALUES ('${digest}', now() + interval '1 hour');
    `);
  }
  compose('up', '--build', '--wait');
  const origin = `http://${compose('port', 'frontend', '80')}/api`;
  assert.equal(migrations(), '4');
  assert.equal((await fetch(`${origin}/dashboard`)).status, 401);
  if (legacyToken) {
    const response = await fetch(`${origin}/dashboard`, { headers: { cookie: `serfing_session=${legacyToken}` } });
    assert.equal(response.status, 200, 'Existing session still works after adopting the Drizzle baseline');
  }

  const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const dashboard = () => fetch(`${origin}/dashboard`, { headers: { cookie } });
  assert.equal((await dashboard()).status, 200);
  const liveUrl = new URL(`${origin}/market/live`);
  const browserOrigin = liveUrl.origin;
  liveUrl.protocol = 'ws:';
  const live = new WebSocket(liveUrl, { headers: { origin: browserOrigin, cookie } });
  try {
    const update = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Market proxy did not deliver a WebSocket message')), 5_000);
      live.addEventListener('message', event => { clearTimeout(timer); resolve(event.data); }, { once: true });
      live.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Market WebSocket upgrade through nginx failed'));
      }, { once: true });
    });
    assert.deepEqual(JSON.parse(update), { stream: 'unconfigured' });
  } finally {
    live.close();
  }

  const tradingUrl = new URL(`${origin}/robot/live`);
  tradingUrl.protocol = 'ws:';
  const trading = new WebSocket(tradingUrl, { headers: { origin: browserOrigin, cookie } });
  try {
    const update = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Trading proxy did not deliver a WebSocket message')), 5_000);
      trading.addEventListener('message', event => { clearTimeout(timer); resolve(event.data); }, { once: true });
      trading.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Trading WebSocket upgrade through nginx failed'));
      }, { once: true });
    });
    assert.deepEqual(JSON.parse(update), { tradingChanged: true });
  } finally {
    trading.close();
  }

  // Force a new backend container without touching the frontend or the database.
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'backend');
  assert.equal(migrations(), '4');
  let status = (await dashboard()).status;
  for (let attempt = 0; status === 502 && attempt < 6; attempt++) {
    await delay(1_000);
    status = (await dashboard()).status;
  }
  assert.equal(status, 200);
  assert.equal((await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { ...headers, cookie } })).status, 204);
  assert.equal((await dashboard()).status, 401);
  console.log(`Compose check passed: ${legacyToken ? 'legacy database adopted without losing a session' : 'fresh database migrated'}, WebSocket proxy, backend recreation, session persistence and logout.`);
} finally {
  compose('down', '--volumes');
}
