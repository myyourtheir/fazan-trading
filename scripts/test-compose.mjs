import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = `serfing-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const env = { ...process.env, OWNER_PASSWORD: password, POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  COOKIE_SECURE: 'false', FRONTEND_PORT: '0' };
const cwd = fileURLToPath(new URL('..', import.meta.url));
const compose = (...args) => execFileSync('docker', ['compose', '-p', project, ...args], {
  cwd, env, encoding: 'utf8', timeout: 180_000,
}).trim();
const headers = { 'Content-Type': 'application/json', 'X-Serfing-Request': '1' };
const migrations = () => compose('exec', '-T', 'postgres', 'psql', '-U', 'serfing', '-d', 'serfing',
  '-Atc', 'SELECT count(*) FROM schema_migrations');

try {
  compose('up', '--build', '--wait');
  const origin = `http://${compose('port', 'frontend', '80')}/api`;
  assert.equal(migrations(), '1');
  assert.equal((await fetch(`${origin}/dashboard`)).status, 401);

  const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const dashboard = () => fetch(`${origin}/dashboard`, { headers: { cookie } });
  assert.equal((await dashboard()).status, 200);

  // Force a new backend container without touching the frontend or the database.
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'backend');
  assert.equal(migrations(), '1');
  let status = (await dashboard()).status;
  for (let attempt = 0; status === 502 && attempt < 6; attempt++) {
    await delay(1_000);
    status = (await dashboard()).status;
  }
  assert.equal(status, 200);
  assert.equal((await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { ...headers, cookie } })).status, 204);
  assert.equal((await dashboard()).status, 401);
  console.log('Compose check passed: clean migration, backend recreation, session persistence and logout.');
} finally {
  compose('down', '--volumes');
}
