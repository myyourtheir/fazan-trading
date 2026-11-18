import assert from 'node:assert/strict';
import { test } from 'node:test';
import { token } from '../core/sandbox.test-support.js';
import { TokenCipher } from './token-cipher.js';

test('the token cannot be decrypted with a different key', () => {
  const cipher = new TokenCipher('ab'.repeat(32));
  const encrypted = cipher.encrypt(token);
  assert.throws(() => new TokenCipher('cd'.repeat(32)).decrypt(encrypted));
  assert.equal(cipher.decrypt(encrypted), token);
});
