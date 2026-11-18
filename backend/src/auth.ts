import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const attemptWindowMs = 60_000;
const maxAttempts = 5;
const sessionToken = /^[A-Za-z0-9_-]{43}$/;

export const ownerCookie = 'serfing_session';

export function ownerSessionToken(cookie: string | undefined) {
  return cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${ownerCookie}=`))?.slice(ownerCookie.length + 1);
}

export interface SessionStore {
  create(digest: string, expiresAt: Date): Promise<void>;
  activeUntil(digest: string, at: Date): Promise<Date | null>;
  revoke(digest: string): Promise<void>;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

type LoginResult =
  | { kind: 'granted'; token: string; ttlMs: number }
  | { kind: 'denied' }
  | { kind: 'throttled'; retryAfter: number };

export class OwnerAuth {
  private windowStart = 0;
  private attempts = 0;

  private constructor(
    private readonly salt: Buffer,
    private readonly expected: Buffer,
    private readonly sessions: SessionStore,
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  static async create(password: string, sessions: SessionStore, options: { now?: () => number; ttlMs?: number } = {}) {
    const salt = randomBytes(32);
    const expected = await derive(password, salt, 64) as Buffer;
    return new OwnerAuth(salt, expected, sessions, options.now ?? Date.now, options.ttlMs ?? 12 * 60 * 60_000);
  }

  async login(password: string): Promise<LoginResult> {
    const now = this.now();
    if (now - this.windowStart >= attemptWindowMs) {
      this.windowStart = now;
      this.attempts = 0;
    }
    if (this.attempts >= maxAttempts) {
      return { kind: 'throttled', retryAfter: Math.max(1, Math.ceil((this.windowStart + attemptWindowMs - now) / 1000)) };
    }
    this.attempts++;
    const candidate = await derive(password, this.salt, 64) as Buffer;
    if (!timingSafeEqual(candidate, this.expected)) return { kind: 'denied' };

    const token = randomBytes(32).toString('base64url');
    await this.sessions.create(digest(token), new Date(this.now() + this.ttlMs));
    this.attempts = 0;
    return { kind: 'granted', token, ttlMs: this.ttlMs };
  }

  async remainingMs(token: string | undefined) {
    if (!token || !sessionToken.test(token)) return 0;
    const until = await this.sessions.activeUntil(digest(token), new Date(this.now()));
    return until ? Math.max(0, until.getTime() - this.now()) : 0;
  }

  async logout(token: string | undefined) {
    if (token && sessionToken.test(token)) await this.sessions.revoke(digest(token));
  }
}
