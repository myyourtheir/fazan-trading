import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ownerSessionToken, type OwnerAuth } from './auth.js';
import type { MarketData } from './market-data.js';

function hasMatchingOriginHost({ headers }: IncomingMessage) {
  if (!headers.origin) return false;
  try {
    const origin = new URL(headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === headers.host;
  } catch {
    return false;
  }
}

export function attachMarketSocket(
  server: Server, auth: OwnerAuth, market: MarketData,
  tradingUpdates?: { subscribe(listener: () => void): () => void },
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const sessions = new Map<WebSocket, string>();
  let stopping = false;

  server.on('upgrade', (request, socket, head) => {
    const onError = () => socket.destroy();
    socket.on('error', onError);
    void authorize().catch(() => socket.destroy());

    async function authorize() {
      const trading = request.url === '/api/robot/live' ? tradingUpdates : undefined;
      if (request.url !== '/api/market/live' && !trading) return reject('404 Not Found');
      if (!hasMatchingOriginHost(request)) return reject('403 Forbidden');
      const token = ownerSessionToken(request.headers.cookie);
      if (!token || !await auth.remainingMs(token)) return reject('401 Unauthorized');
      if (stopping || socket.destroyed) return socket.destroy();

      sockets.handleUpgrade(request, socket, head, ws => {
        socket.off('error', onError);
        sessions.set(ws, token);
        let unsubscribe: (() => void) | undefined;
        let expiry: ReturnType<typeof setTimeout> | undefined;
        let alive = true;
        ws.on('error', () => ws.terminate());
        ws.on('message', () => ws.close(1008));
        ws.on('pong', () => { alive = true; });
        const heartbeat = setInterval(() => {
          if (!alive) return ws.terminate();
          alive = false;
          ws.ping();
        }, 20_000);
        ws.once('close', () => {
          sessions.delete(ws);
          clearInterval(heartbeat);
          clearTimeout(expiry);
          unsubscribe?.();
        });
        void start().catch(() => ws.close(1011));

        async function start() {
          // Recheck after registering the socket so concurrent logout cannot leave it authorized.
          const remainingMs = await auth.remainingMs(token);
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!remainingMs) return ws.close(1008);
          expiry = setTimeout(() => ws.close(1008), remainingMs);
          const send = (update: unknown) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 256 * 1024) return ws.terminate();
            ws.send(JSON.stringify(update));
          };
          if (trading) {
            const notify = () => send({ tradingChanged: true });
            unsubscribe = trading.subscribe(notify);
            notify();
            return;
          }
          const stop = await market.subscribe(send);
          if (ws.readyState === WebSocket.OPEN) unsubscribe = stop;
          else stop();
        }
      });
    }

    function reject(status: string) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });

  return {
    revoke(token: string | undefined) {
      if (!token) return;
      for (const [ws, session] of sessions) if (session === token) ws.close(1008);
    },
    reload() {
      for (const ws of sockets.clients) ws.close(1012);
    },
    shutdown() {
      stopping = true;
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}
