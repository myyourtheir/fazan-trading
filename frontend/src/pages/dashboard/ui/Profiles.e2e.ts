import { expect, test } from '@playwright/test';

test('profiles switch independently, survive reload and require explicit legacy claim', async ({
  page,
}) => {
  test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses mocked profiles.');
  const future = (uid: string) => ({
    uid,
    ticker: uid,
    name: uid,
    classCode: 'FUT',
    exchange: 'MOEX',
    expirationDate: null,
  });
  const surfing = {
    instrument: future('SURF'),
    timeframe: '1h',
    kind: 'surfing',
    parameters: { emaPeriod: 55, lots: 2 },
  };
  const improved = {
    instrument: future('IMPROVED'),
    timeframe: '15m',
    kind: 'improved-surfing',
    parameters: {
      emaPeriod: 30,
      atrPeriod: 20,
      stopAtrMultiplier: 2,
      addStepAtr: 1,
      maxAddOns: 3,
      tradeWeekends: false,
    },
  };
  let selected = 'surfing';
  let claimed = false;
  let starts = 0;
  await page.route('/api/**', (route) => {
    const request = route.request();
    switch (new URL(request.url()).pathname) {
      case '/api/auth/session':
        return route.fulfill({ json: { authenticated: true, remainingMs: 60000 } });
      case '/api/dashboard':
        return route.fulfill({ json: { mode: 'stopped', reason: null, position: 0 } });
      case '/api/sandbox':
        return route.fulfill({
          json: {
            status: 'connected',
            accountId: 'account',
            accounts: [{ id: 'account', name: 'Sandbox' }],
          },
        });
      case '/api/strategy/profiles':
        return route.fulfill({
          json: {
            selected,
            legacyClaimAvailable: !claimed,
            profiles: {
              surfing: {
                defaults: { ticker: 'IMOEXF', timeframe: '1h', emaPeriod: 55 },
                settings: surfing,
              },
              'improved-surfing': {
                defaults: { ticker: 'IMOEXF', timeframe: '1h', ...improved.parameters },
                settings: improved,
              },
            },
          },
        });
      case '/api/strategy/selection':
        selected = request.postDataJSON().kind;
        return route.fulfill({ status: 204 });
      case '/api/strategy/legacy-claim':
        expect(request.postDataJSON()).toEqual({ confirmed: true });
        claimed = true;
        return route.fulfill({ status: 204 });
      case '/api/strategy/futures':
        return route.fulfill({ json: [future('SURF'), future('IMPROVED')] });
      case '/api/market':
        return route.fulfill({ json: null });
      case '/api/robot/start':
        starts++;
        return route.fulfill({ status: 204 });
      default:
        return route.fulfill({ json: [] });
    }
  });
  await page.routeWebSocket('**/api/**/live', () => {});
  await page.goto('/dashboard');
  const selector = page.getByRole('combobox', { name: 'Стратегия' });
  await expect(selector).toHaveValue('surfing');
  await expect(page.getByLabel('Период EMA')).toHaveValue('55');
  await selector.selectOption('improved-surfing');
  await expect(page.getByLabel('Период EMA')).toHaveValue('30');
  await expect(page.getByLabel('Период ATR')).toHaveValue('20');
  await expect(page.getByRole('button', { name: 'Запустить робота' })).toBeDisabled();
  await expect(page.getByText(/безопасной работы защитных стопов/)).toBeVisible();
  expect(starts).toBe(0);
  await page.reload();
  await expect(selector).toHaveValue('improved-surfing');
  await selector.selectOption('surfing');
  await expect(page.getByLabel('Период EMA')).toHaveValue('55');
  await page.getByRole('button', { name: 'Привязать прежние настройки Surfing' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Отмена' }).click();
  expect(claimed).toBe(false);
  await page.getByRole('button', { name: 'Привязать прежние настройки Surfing' }).click();
  await page.getByRole('button', { name: 'Подтвердить привязку' }).click();
  await expect(
    page.getByRole('button', { name: 'Привязать прежние настройки Surfing' }),
  ).toHaveCount(0);
});

for (const mode of ['stopped', 'paused'] as const) {
  test(`legacy profile can be claimed during ${mode} order recovery and explicitly resumed`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked upgrade and recovery.');
    const instrument = {
      uid: 'legacy',
      ticker: 'IMOEXF',
      name: 'IMOEXF',
      classCode: 'FUT',
      exchange: 'MOEX',
      expirationDate: null,
    };
    const legacy = {
      instrument,
      timeframe: '1h',
      kind: 'surfing',
      parameters: { emaPeriod: 55, lots: 2 },
    };
    let claimed = false;
    let resumed = false;
    let starts = 0;
    await page.route('/api/**', (route) => {
      const request = route.request();
      switch (new URL(request.url()).pathname) {
        case '/api/auth/session':
          return route.fulfill({ json: { authenticated: true, remainingMs: 60000 } });
        case '/api/dashboard':
          return route.fulfill({
            json: resumed
              ? { mode: 'running', reason: null, position: 0 }
              : {
                  mode,
                  reason: 'ROBOT_ORDER_UNRESOLVED',
                  position: 0,
                  recovery: { orderId: 'old-order', ready: true },
                },
          });
        case '/api/sandbox':
          return route.fulfill({
            json: {
              status: 'connected',
              accountId: 'account',
              accounts: [{ id: 'account', name: 'Sandbox' }],
            },
          });
        case '/api/strategy/profiles':
          return route.fulfill({
            json: {
              selected: 'surfing',
              legacyClaimAvailable: !claimed,
              profiles: {
                surfing: {
                  defaults: { ticker: 'IMOEXF', timeframe: '1h', emaPeriod: 55 },
                  settings: claimed ? legacy : null,
                },
                'improved-surfing': {
                  defaults: {
                    ticker: 'IMOEXF',
                    timeframe: '1h',
                    emaPeriod: 55,
                    atrPeriod: 20,
                    stopAtrMultiplier: 2,
                    addStepAtr: 1,
                    maxAddOns: 3,
                    tradeWeekends: false,
                  },
                  settings: null,
                },
              },
            },
          });
        case '/api/strategy/legacy-claim':
          expect(request.postDataJSON()).toEqual({ confirmed: true });
          claimed = true;
          return route.fulfill({ status: 204 });
        case '/api/strategy/futures':
          return route.fulfill({ json: [instrument] });
        case '/api/robot/resume':
          expect(claimed).toBe(true);
          resumed = true;
          return route.fulfill({ status: 204 });
        case '/api/robot/start':
          starts++;
          return route.fulfill({ status: 204 });
        case '/api/market':
          return route.fulfill({ json: null });
        default:
          return route.fulfill({ json: [] });
      }
    });
    await page.routeWebSocket('**/api/**/live', () => {});
    await page.goto('/dashboard');
    await expect(page.getByRole('combobox', { name: 'Стратегия' })).toBeDisabled();
    await expect(page.getByText('Клиентский ID: old-order')).toBeVisible();
    const claim = page.getByRole('button', { name: 'Привязать прежние настройки Surfing' });
    await expect(claim).toBeEnabled();
    await claim.click();
    expect(claimed).toBe(false);
    await page.getByRole('button', { name: 'Подтвердить привязку' }).click();
    await expect(claim).toHaveCount(0);
    await expect(page.getByLabel('Объём, лотов')).toHaveValue('2');
    expect(starts).toBe(0);
    expect(resumed).toBe(false);
    await page.getByRole('button', { name: 'Возобновить торговлю' }).click();
    await expect(page.getByText('Робот запущен')).toBeVisible();
    expect(resumed).toBe(true);
    expect(starts).toBe(0);
  });
}

for (const ambiguous of [false, true]) {
  test(`unsaved improved profile ${ambiguous ? 'requires explicit selection for ambiguous' : 'selects unique exact'} default contract`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.SERFING_E2E_URL), 'Uses a mocked catalogue.');
    const future = (uid: string, ticker: string) => ({
      uid,
      ticker,
      name: ticker,
      classCode: 'FUT',
      exchange: 'MOEX',
      expirationDate: null,
    });
    const catalogue = [
      future('other', 'IMOEXF-OTHER'),
      future('default', 'IMOEXF'),
      ...(ambiguous ? [{ ...future('second', 'IMOEXF'), exchange: 'OTHER' }] : []),
    ];
    let savedUid = '';
    let profileFetches = 0;
    await page.route('/api/**', (route) => {
      const request = route.request();
      switch (new URL(request.url()).pathname) {
        case '/api/auth/session':
          return route.fulfill({ json: { authenticated: true, remainingMs: 60000 } });
        case '/api/dashboard':
          return route.fulfill({ json: { mode: 'stopped', reason: null, position: 0 } });
        case '/api/sandbox':
          return route.fulfill({
            json: {
              status: 'connected',
              accountId: 'account',
              accounts: [{ id: 'account', name: 'Sandbox' }],
            },
          });
        case '/api/strategy/profiles':
          profileFetches++;
          return route.fulfill({
            json: {
              selected: 'improved-surfing',
              legacyClaimAvailable: false,
              profiles: {
                surfing: {
                  defaults: { ticker: 'IMOEXF', timeframe: '1h', emaPeriod: 55 },
                  settings: null,
                },
                'improved-surfing': {
                  defaults: {
                    ticker: 'IMOEXF',
                    timeframe: '1h',
                    emaPeriod: 55,
                    atrPeriod: 20,
                    stopAtrMultiplier: 2,
                    addStepAtr: 1,
                    maxAddOns: 3,
                    tradeWeekends: false,
                  },
                  settings: savedUid
                    ? {
                        instrument: catalogue.find((item) => item.uid === savedUid),
                        timeframe: '1h',
                        parameters: {
                          emaPeriod: 55,
                          atrPeriod: 20,
                          stopAtrMultiplier: 2,
                          addStepAtr: 1,
                          maxAddOns: 3,
                          tradeWeekends: false,
                        },
                      }
                    : null,
                },
              },
            },
          });
        case '/api/strategy/futures':
          return route.fulfill({ json: catalogue });
        case '/api/strategy':
          savedUid = request.postDataJSON().instrumentUid;
          return route.fulfill({ status: 204 });
        case '/api/market':
          return route.fulfill({ json: null });
        default:
          return route.fulfill({ json: [] });
      }
    });
    await page.routeWebSocket('**/api/**/live', () => {});
    await page.goto('/dashboard');
    const select = page.getByLabel('Контракт');
    const save = page.getByRole('button', { name: 'Сохранить настройки' });
    await expect(select.getByRole('option')).toHaveCount(catalogue.length + 1);
    await expect(select).toHaveValue(ambiguous ? '' : 'default');
    if (ambiguous) {
      await expect(save).toBeDisabled();
      await select.selectOption({ label: 'IMOEXF · IMOEXF · FUT · OTHER · Бессрочный' });
    }
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => savedUid).toBe(ambiguous ? 'second' : 'default');
    await expect.poll(() => profileFetches).toBeGreaterThan(1);
    await expect(select).toHaveValue(ambiguous ? 'second' : 'default');
    await expect(select.locator('option:checked')).toHaveText(
      `IMOEXF · IMOEXF · FUT · ${ambiguous ? 'OTHER' : 'MOEX'} · Бессрочный`,
    );
  });
}
