import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { OwnerAuth } from '../core/auth.js';
import { MarketData } from '../core/market-data.js';
import { createApp } from './app.js';
import { attachMarketSocket } from './market-socket.js';

test('market REST and WebSocket require an owner session; logout closes the live socket', { timeout: 5_000 }, async t => {
  const sessions = new Map<string, Date>();
  const password = 'test-owner-password';
  const auth = await OwnerAuth.create(password, {
    async create(digest, expires) { sessions.set(digest, expires); },
    async activeUntil(digest) { return sessions.get(digest) ?? null; },
    async revoke(digest) { sessions.delete(digest); },
  });
  const market = new MarketData({
    async candles() { return []; },
    async ema() { return []; },
    async *stream(_token, _uid, _timeframe, signal) {
      yield { kind: 'subscribed' };
      await delay(60_000, undefined, { signal }).catch(() => {});
    },
  }, async () => ({ token: 'not-for-browser', instrumentUid: 'future', emaPeriod: 55, timeframe: '30m' }));
  const server = createServer();
  const marketSocket = attachMarketSocket(server, auth, market);
  server.on('request', createApp({ auth, market, marketSocket, secureCookies: false }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    marketSocket.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `ws://127.0.0.1:${address.port}/api/market/live`;
  const mutationHeaders = { 'Content-Type': 'application/json', 'X-Serfing-Request': '1' };
  const rejected = (source: string, cookie?: string) => new Promise<number | undefined>((resolve, reject) => {
    const socket = new WebSocket(url, { origin: source, headers: cookie ? { cookie } : {} });
    socket.on('error', reject);
    socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected WebSocket upgrade')); });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });

  assert.equal((await fetch(`${origin}/api/market`)).status, 401);
  assert.equal(await rejected(origin), 401);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal(await rejected('http://different.example', cookie), 403);
  const rest = await fetch(`${origin}/api/market`, { headers: { cookie } });
  assert.deepEqual(await rest.json(), { instrumentUid: 'future', emaPeriod: 55, timeframe: '30m', candles: [] });

  const ws = new WebSocket(url, { origin, headers: { cookie } });
  const events: unknown[] = [];
  const liveHistory = new Promise<void>(resolve => ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    events.push(message);
    if (message.history) resolve();
  }));
  await liveHistory;
  assert.deepEqual(events, [
    { stream: 'connecting' }, { stream: 'live' },
    { stream: 'live', history: { instrumentUid: 'future', emaPeriod: 55, timeframe: '30m', candles: [] } },
  ]);
  const closed = once(ws, 'close');
  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST', headers: { ...mutationHeaders, cookie },
  });
  assert.equal(logout.status, 204);
  assert.equal((await closed)[0], 1008);
  assert.equal(await rejected(origin, cookie), 401);
});

test('trading notifications stream on their own socket; other upgrades are refused', { timeout: 5_000 }, async t => {
  const sessions = new Map<string, Date>();
  const auth = await OwnerAuth.create('test-owner-password', {
    async create(digest, expires) { sessions.set(digest, expires); },
    async activeUntil(digest) { return sessions.get(digest) ?? null; },
    async revoke(digest) { sessions.delete(digest); },
  });
  const listeners = new Set<() => void>();
  const server = createServer();
  const marketSocket = attachMarketSocket(server, auth, {
    async candles() { return []; },
    async ema() { return []; },
    async *stream() { yield { kind: 'subscribed' } as const; },
  } as unknown as MarketData, {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  server.on('request', createApp({ auth, secureCookies: false }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    marketSocket.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const mutationHeaders = { 'Content-Type': 'application/json', 'X-Serfing-Request': '1' };
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ password: 'test-owner-password' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const refused = (path: string, headers: { origin: string; cookie?: string }) =>
    new Promise<number | undefined>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, headers);
      socket.on('error', reject);
      socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected WebSocket upgrade')); });
      socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    });
  assert.equal(await refused('/api/robot/live', { origin }), 401);
  assert.equal(await refused('/api/unknown', { origin, cookie }), 404);

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/robot/live`, { origin, headers: { cookie } });
  const updates: unknown[] = [];
  const received = new Promise<void>(resolve => ws.on('message', bytes => {
    updates.push(JSON.parse(bytes.toString()));
    if (updates.length === 1) for (const listener of listeners) listener();
    if (updates.length === 2) resolve();
  }));
  await received;
  assert.deepEqual(updates, [{ tradingChanged: true }, { tradingChanged: true }]);
  ws.close();
});
