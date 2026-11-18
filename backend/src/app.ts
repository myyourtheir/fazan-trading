import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import type { OwnerAuth } from './auth.js';
import { SandboxError, type SandboxConnection } from './sandbox.js';
import { sandboxRoutes } from './sandbox-routes.js';
import { strategyRoutes } from './strategy-routes.js';
import type { StrategySettings } from './strategy-settings.js';

const cookieName = 'serfing_session';

function sessionToken(request: Request) {
  return request.headers.cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

export function createApp({ auth, secureCookies, sandbox, strategy }: {
  auth: OwnerAuth; secureCookies: boolean; sandbox?: SandboxConnection; strategy?: StrategySettings;
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
    const remainingMs = await auth.remainingMs(sessionToken(req));
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
    await auth.logout(sessionToken(req));
    res.cookie(cookieName, result.token, { ...cookie, maxAge: result.ttlMs }).json({ authenticated: true });
  });
  api.post('/auth/logout', async (req, res) => {
    await auth.logout(sessionToken(req));
    res.clearCookie(cookieName, cookie).sendStatus(204);
  });
  api.get('/auth/session', requireOwner, (_req, res) => res.json({
    authenticated: true, remainingMs: res.locals.sessionRemainingMs,
  }));
  api.get('/dashboard', requireOwner, (_req, res) => res.json({ mode: 'stopped' }));
  if (sandbox) api.use('/sandbox', sandboxRoutes(sandbox, requireOwner));
  if (strategy) api.use('/strategy', strategyRoutes(strategy, requireOwner));
  api.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));

  const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SandboxError) {
      res.status(error.status).json({ code: error.code });
      return;
    }
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (status === 400 || status === 413) {
      res.status(status).json({ code: 'INVALID_REQUEST' });
      return;
    }
    console.error('Serfing API request failed.');
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  };
  app.use('/api', api);
  app.use(onError);
  return app;
}
