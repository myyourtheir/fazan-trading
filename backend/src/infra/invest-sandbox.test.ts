import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InstrumentStatus } from '@ttech-pub/grpc-node-client/compiled/common.js';
import { Status } from 'nice-grpc';
import { futures, token } from '../core/sandbox.test-support.js';
import { InvestSandbox } from './invest-sandbox.js';

test('the SDK adapter distinguishes definite rejection from transport failure', async (t) => {
  let code = Status.INVALID_ARGUMENT;
  const create = t.mock.method(
    NodeApiClient,
    'create',
    async () =>
      ({
        sandbox: {
          async sandboxPayIn() {
            throw Object.assign(new Error(`broker details: ${token}`), { code });
          },
        },
      }) as unknown as NodeApiClient,
  );
  const adapter = new InvestSandbox();
  await assert.rejects(adapter.fundAccount(token, 'new'), {
    message: 'SANDBOX_OPERATION_REJECTED',
  });
  code = Status.UNAVAILABLE;
  await assert.rejects(adapter.fundAccount(token, 'new'), { message: 'SANDBOX_UNREACHABLE' });
  assert.deepEqual(create.mock.calls[0].arguments[0], {
    token,
    url: 'https://sandbox-invest-public-api.tbank.ru:443',
    telemetry: 'disabled',
    useMincifryCertificate: true,
  });
});

test('the SDK requests the base futures catalogue through the sandbox channel', async (t) => {
  const instruments = {
    async futures(_request: { instrumentStatus: InstrumentStatus }) {
      return {
        instruments: [{ ...futures[1], expirationDate: new Date(futures[1].expirationDate!) }],
      };
    },
  };
  const list = t.mock.method(instruments, 'futures');
  const create = t.mock.method(
    NodeApiClient,
    'create',
    async () => ({ instruments }) as unknown as NodeApiClient,
  );
  assert.deepEqual(await new InvestSandbox().futures(token), [futures[1]]);
  assert.equal(
    create.mock.calls[0].arguments[0]?.url,
    'https://sandbox-invest-public-api.tbank.ru:443',
  );
  assert.deepEqual(list.mock.calls[0].arguments[0], {
    instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_BASE,
  });
});
