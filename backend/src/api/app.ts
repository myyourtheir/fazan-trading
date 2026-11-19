import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { OwnerAuth } from '../core/auth.js';
import { ownerCookie, ownerSessionToken } from './cookies.js';
import type { MarketData } from '../core/market-data.js';
import { RobotError, type Robot } from '../core/robot.js';
import { SandboxError, type SandboxConnection } from '../core/sandbox.js';
import { sandboxRoutes } from './sandbox-routes.js';
import { strategyRoutes } from './strategy-routes.js';
import { brokerIdLimit, isPrintableAscii } from './request-validation.js';
import type { StrategySettings } from '../core/strategy-settings.js';
import type { BacktestHistory } from '../core/backtest-history.js';
import { backtestRoutes } from './backtest-routes.js';
import { defaultTimeZone, type DisplaySettings } from '../core/display-settings.js';

export function createApp({ auth, secureCookies, settings, displaySettings, market, marketSocket, robot, backtest }: {
  auth: OwnerAuth; secureCookies: boolean;
  settings?: { sandbox: SandboxConnection; strategy?: StrategySettings; change: (action: () => Promise<void>) => Promise<void> };
  displaySettings?: DisplaySettings;
  market?: MarketData;
  robot?: Robot;
  backtest?: BacktestHistory;
  marketSocket?: { revoke(token: string | undefined): void; reload(): void };
}) {
  const app = express();
  app.disable('x-powered-by');
  const api = express.Router();
  const cookie = { httpOnly: true, sameSite: 'strict' as const, secure: secureCookies, path: '/api' };
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    next();
  });

  api.use((req, res, next) => {
    // A browser cannot add this non-simple header to a cross-origin request
    // without a successful CORS preflight; this API does not enable CORS.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Serfing-Request') !== '1') {
      res.status(403).json({ code: 'FORBIDDEN' });
      return;
    }
    next();
  });
  api.use(express.json({ limit: '4kb' }));

  const requireOwner: RequestHandler = async (req, res, next) => {
    const remainingMs = await auth.remainingMs(ownerSessionToken(req.headers.cookie));
    if (!remainingMs) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }
    res.locals.sessionRemainingMs = remainingMs;
    next();
  };

  api.get('/health', (_req, res) => res.json({ status: 'ready' }));
  api.post('/auth/login', async (req, res) => {
    const password: unknown = req.body?.password;
    if (typeof password !== 'string' || !password.length || password.length > 256) {
      res.status(400).json({ code: 'INVALID_PASSWORD_FORMAT' });
      return;
    }
    const result = await auth.login(password);
    if (result.kind === 'denied') {
      res.status(401).json({ code: 'INVALID_CREDENTIALS' });
      return;
    }
    if (result.kind === 'throttled') {
      res.set('Retry-After', String(result.retryAfter)).status(429).json({ code: 'TOO_MANY_ATTEMPTS' });
      return;
    }
    const previous = ownerSessionToken(req.headers.cookie);
    await auth.logout(previous);
    marketSocket?.revoke(previous);
    res.cookie(ownerCookie, result.token, { ...cookie, maxAge: result.ttlMs }).json({ authenticated: true });
  });
  api.post('/auth/logout', async (req, res) => {
    const token = ownerSessionToken(req.headers.cookie);
    await auth.logout(token);
    marketSocket?.revoke(token);
    res.clearCookie(ownerCookie, cookie).sendStatus(204);
  });
  api.get('/auth/session', requireOwner, (_req, res) => res.json({
    authenticated: true, remainingMs: res.locals.sessionRemainingMs,
  }));
  if (displaySettings) {
    api.get('/settings/display', requireOwner, async (_req, res) => res.json(await displaySettings.get()));
    api.put('/settings/display', requireOwner, async (req, res) => {
      const saved = await displaySettings.setTimeZone(req.body?.timeZone);
      if (!saved) {
        res.status(400).json({ code: 'INVALID_TIME_ZONE' });
        return;
      }
      res.json(saved);
    });
  }
  api.get('/dashboard', requireOwner, (_req, res) => res.json(robot?.status() ?? { mode: 'stopped' }));
  if (settings) {
    const { sandbox, strategy, change } = settings;
    const replaceCredentials = robot
      ? robot.replaceCredentials.bind(robot)
      : (action: (accountId?: string) => Promise<void>) => change(() => action());
    api.use('/sandbox', sandboxRoutes(sandbox, requireOwner, change, replaceCredentials, marketSocket?.reload));
    if (strategy) api.use('/strategy', strategyRoutes(strategy, requireOwner, change, marketSocket?.reload));
  }
  if (backtest) api.use('/backtest', backtestRoutes(backtest, requireOwner,
    async () => (await displaySettings?.get())?.timeZone ?? defaultTimeZone));
  if (market) api.get('/market', requireOwner, async (_req, res) => res.json(await market.history()));
  if (robot) {
    api.get('/robot/history', requireOwner, async (req, res) => {
      const { accountId } = req.query;
      if (accountId !== undefined && !isPrintableAscii(accountId, brokerIdLimit)) {
        res.status(400).json({ code: 'INVALID_REQUEST' });
        return;
      }
      res.json(await robot.history(accountId));
    });
    api.post('/robot/start', requireOwner, async (_req, res) => {
      await robot.start();
      res.status(204).end();
    });
    api.post('/robot/stop', requireOwner, (_req, res) => {
      robot.stop();
      res.status(204).end();
    });
    api.post('/robot/reconcile', requireOwner, async (_req, res) => {
      await robot.reconcile();
      res.status(204).end();
    });
    api.post('/robot/resume', requireOwner, async (_req, res) => {
      await robot.resume();
      res.status(204).end();
    });
    api.post('/robot/close', requireOwner, async (req, res) => {
      const { accountId, instrumentUid, confirmed } = req.body ?? {};
      if (confirmed !== true || !isPrintableAscii(accountId, brokerIdLimit) || !isPrintableAscii(instrumentUid, brokerIdLimit)) {
        res.status(400).json({ code: 'INVALID_REQUEST' });
        return;
      }
      await robot.closePosition({ accountId, instrumentUid });
      res.status(204).end();
    });
  }
  api.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));

  const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SandboxError || error instanceof RobotError) {
      res.status(error.status).json({ code: error.code });
      return;
    }
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({ code: 'INVALID_REQUEST' });
      return;
    }
    console.error('fazan-trading API request failed.');
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  };
  app.use('/api', api);
  app.use(onError);
  return app;
}
