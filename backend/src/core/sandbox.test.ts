import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxConnection, type SavedSandboxConnection } from './sandbox.js';
import { fakeBroker, token } from './sandbox.test-support.js';

test('switching accounts requires both the old and new account to be verified flat', async () => {
  let saved: SavedSandboxConnection = { encryptedToken: token, accountId: 'existing' };
  const { broker } = fakeBroker();
  broker.accounts = async () => [
    { id: 'existing', name: 'Old' },
    { id: 'new', name: 'New' },
  ];
  let result: boolean | null = false;
  const checked: string[] = [];
  broker.accountIsFlat = async (_token, accountId) => {
    checked.push(accountId);
    return accountId === 'existing' ? true : result;
  };
  const sandbox = new SandboxConnection(
    {
      async load() {
        return saved;
      },
      async save(value) {
        saved = value;
      },
    },
    { encrypt: (value) => value, decrypt: (value) => value },
    broker,
  );
  await assert.rejects(sandbox.selectAccount('new'), { code: 'SANDBOX_ACCOUNT_NOT_FLAT' });
  assert.deepEqual(checked, ['existing', 'new']);
  assert.equal(saved.accountId, 'existing');
  result = null;
  await assert.rejects(sandbox.selectAccount('new'), { code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED' });
  assert.equal(saved.accountId, 'existing');
  result = true;
  await sandbox.selectAccount('new');
  assert.equal(saved.accountId, 'new');
});

test('creating an account does not select it unless the new account is verified flat', async () => {
  let saved: SavedSandboxConnection = { encryptedToken: token, accountId: 'existing' };
  const { broker } = fakeBroker();
  broker.openAccount = async () => 'new';
  const checked: string[] = [];
  let target: boolean | null = null;
  broker.accountIsFlat = async (_token, accountId) => {
    checked.push(accountId);
    return accountId === 'existing' ? true : target;
  };
  const sandbox = new SandboxConnection(
    {
      async load() {
        return saved;
      },
      async save(value) {
        saved = value;
      },
    },
    { encrypt: (value) => value, decrypt: (value) => value },
    broker,
  );

  await assert.rejects(sandbox.createAccount(), { code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED' });
  assert.deepEqual(checked, ['existing', 'new']);
  assert.equal(saved.accountId, 'existing');
  target = false;
  await assert.rejects(sandbox.createAccount(), { code: 'SANDBOX_ACCOUNT_NOT_FLAT' });
  assert.equal(saved.accountId, 'existing');
  target = true;
  await sandbox.createAccount();
  assert.equal(saved.accountId, 'new');
});

test('initial selection fails closed when the broker cannot verify the target account', async () => {
  let saved: SavedSandboxConnection = { encryptedToken: token, accountId: null };
  const { broker } = fakeBroker();
  let available = false;
  broker.accountIsFlat = async (_token, accountId) => {
    assert.equal(accountId, 'existing');
    if (!available) throw new Error('broker unavailable');
    return true;
  };
  const sandbox = new SandboxConnection(
    {
      async load() {
        return saved;
      },
      async save(value) {
        saved = value;
      },
    },
    { encrypt: (value) => value, decrypt: (value) => value },
    broker,
  );

  await assert.rejects(sandbox.selectAccount('existing'), {
    code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED',
  });
  assert.equal(saved.accountId, null);
  available = true;
  await sandbox.selectAccount('existing');
  assert.equal(saved.accountId, 'existing');
});

test('fresh start rechecks predecessor with its saved credential after repair and restart', async () => {
  let saved: SavedSandboxConnection = { encryptedToken: token, accountId: 'existing' };
  const { broker } = fakeBroker();
  broker.accounts = async () => [
    { id: 'existing', name: 'Old' },
    { id: 'new', name: 'New' },
  ];
  const checked: string[] = [];
  let oldFlat = true;
  broker.accountIsFlat = async (credential, accountId) => {
    checked.push(`${credential}:${accountId}`);
    return accountId === 'existing' ? oldFlat : true;
  };
  const store = {
    async load() {
      return saved;
    },
    async save(value: SavedSandboxConnection) {
      saved = value;
    },
  };
  const cipher = { encrypt: (value: string) => value, decrypt: (value: string) => value };
  let sandbox = new SandboxConnection(store, cipher, broker);
  await sandbox.selectAccount('new');
  await sandbox.connect('rotated');
  sandbox = new SandboxConnection(store, cipher, broker);
  checked.length = 0;
  oldFlat = false;
  await assert.rejects(sandbox.verifyFreshStart(), { code: 'SANDBOX_ACCOUNT_NOT_FLAT' });
  assert.deepEqual(checked, [`${token}:existing`]);
  oldFlat = true;
  checked.length = 0;
  await sandbox.verifyFreshStart();
  assert.deepEqual(checked, [`${token}:existing`, 'rotated:new']);
});

test('fresh start fails closed when the selected account can no longer be verified', async () => {
  const saved: SavedSandboxConnection = {
    encryptedToken: 'current-token',
    accountId: 'new',
    previousAccountId: 'old',
    previousEncryptedToken: 'old-token',
  };
  const { broker } = fakeBroker();
  const checked: string[] = [];
  broker.accountIsFlat = async (credential, accountId) => {
    checked.push(`${credential}:${accountId}`);
    return accountId === 'old' ? true : null;
  };
  const sandbox = new SandboxConnection(
    { load: async () => saved, save: async () => {} },
    { encrypt: (value) => value, decrypt: (value) => value },
    broker,
  );

  await assert.rejects(sandbox.verifyFreshStart(), { code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED' });
  assert.deepEqual(checked, ['old-token:old', 'current-token:new']);
});
