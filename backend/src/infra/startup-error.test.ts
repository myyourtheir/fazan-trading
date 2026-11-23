import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupErrorMessage } from './startup-error.js';
import { TokenCipher } from './token-cipher.js';

test('reports the safe encryption key diagnostic without exposing invalid key values', () => {
  const expected =
    'SANDBOX_TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hexadecimal characters.';
  for (const key of [undefined, 'secret-invalid-key']) {
    assert.throws(
      () => new TokenCipher(key),
      (error: unknown) => {
        assert.equal(startupErrorMessage(error, 'configuration'), expected);
        return true;
      },
    );
  }
  assert.equal(
    startupErrorMessage(new Error(`${expected} secret-invalid-key`), 'configuration'),
    'Backend startup failed during configuration. Check configuration, database, and listening address.',
  );
});

test('reports a wrapped PostgreSQL cause without exposing query data or credentials', () => {
  const error = new Error('query with secret parameter', {
    cause: Object.assign(new Error('relation "app_owner" does not exist; password=secret'), {
      code: '42P01',
      detail: 'postgres://user:secret@host/db',
    }),
  });
  assert.equal(
    startupErrorMessage(error, 'app_owner initialization'),
    'Backend startup failed during app_owner initialization: PostgreSQL relation does not exist (42P01).',
  );
});

test('reports duplicate relations during migrations without exposing error details', () => {
  const error = new Error('CREATE TABLE strategy_profiles (secret text)', {
    cause: Object.assign(new Error('relation "strategy_profiles" already exists'), {
      code: '42P07',
      detail: 'password=secret',
    }),
  });
  assert.equal(
    startupErrorMessage(error, 'database migrations'),
    'Backend startup failed during database migrations: PostgreSQL relation already exists (42P07).',
  );
});

test('unknown errors and cyclic causes are not logged verbatim', () => {
  const error: { code: string; cause?: unknown } = { code: 'secret-token' };
  error.cause = error;
  assert.equal(
    startupErrorMessage(error, 'database migrations'),
    'Backend startup failed during database migrations. Check configuration, database, and listening address.',
  );
});
