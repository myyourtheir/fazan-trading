import assert from 'node:assert/strict';
import { SandboxError, type SandboxBroker } from './sandbox.js';

export const token = 'sandbox-secret-not-for-the-browser';
export const futures = [
  { uid: 'contract-a', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: null, apiTradeAvailableFlag: true },
  { uid: 'contract-b', ticker: 'IMOEXF', name: 'Другой контракт', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: '2027-03-18T00:00:00.000Z', apiTradeAvailableFlag: true },
  { uid: 'unavailable', ticker: 'IMOEXF', name: 'Недоступный контракт', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: null, apiTradeAvailableFlag: false },
];

export function fakeBroker() {
  const accounts = [{ id: 'existing', name: 'Existing sandbox account' }];
  const funded: string[] = [];
  let offline = false;
  let fundingUncertain = false;
  const broker: SandboxBroker = {
    async accounts(candidate) {
      if (offline) throw new SandboxError('SANDBOX_UNREACHABLE');
      if (candidate !== token) throw new SandboxError('SANDBOX_TOKEN_REJECTED');
      return [...accounts];
    },
    async openAccount() {
      accounts.push({ id: 'new', name: 'Сёрфинг' });
      return 'new';
    },
    async fundAccount(_token, accountId) {
      funded.push(accountId);
      if (fundingUncertain) throw new SandboxError('SANDBOX_UNREACHABLE');
    },
    async balanceRubles(candidate) {
      assert.equal(candidate, token);
      if (offline) throw new SandboxError('SANDBOX_UNREACHABLE');
      return 100_000.25;
    },
    async accountIsFlat() { return offline ? null : true; },
    async futures(candidate) {
      if (offline) throw new SandboxError('SANDBOX_UNREACHABLE');
      assert.equal(candidate, token);
      return futures;
    },
  };
  return { broker, funded, goOffline: () => { offline = true; }, loseFundingReply: () => { fundingUncertain = true; } };
}
