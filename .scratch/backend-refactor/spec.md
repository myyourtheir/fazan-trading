# Спецификация: Слоистая структура бекенда

Status: ready-for-agent

## Проблема

Все 16 модулей бекенда лежат в плоском `backend/src/`. Человеку трудно сориентироваться, где домен и сценарии, где адаптеры брокера и PostgreSQL, а где HTTP-поверхность. Граница «домен не зависит от инфраструктуры» держится только на договорённости: сегодня единственное ребро — импорт типа `TokenCipher` из `token-cipher.ts` в `sandbox.ts`, и ничто механически не мешает появлению новых.

## Решение

Разнести `src/` по трём слоям с жёсткой матрицей направлений импортов и проверкой матрицы в `npm test`. Композиция остаётся в `main.ts`. Поведение и публичные контракты не меняются.

## Структура

```
backend/src/
  core/                  # домен и сценарии; ничего не знает об express, pg, grpc
    crossing.ts          # чистая логика сигналов и position-delta
    robot.ts             # Robot + порты Broker, TradingStore
    market-data.ts       # MarketData, MarketSeries/EMA + порт MarketBroker
    sandbox.ts           # SandboxConnection + порты SandboxBroker, SandboxStore, TokenCipher
    strategy-settings.ts # StrategySettings + порт StrategyStore
    auth.ts              # OwnerAuth + порт SessionStore
  infra/                 # реализует порты core
    invest-sandbox.ts    # gRPC-клиент Т-Инвестиций (Broker, SandboxBroker, MarketBroker)
    postgres.ts          # Drizzle-адаптеры портов + применение миграций
    db/schema.ts         # Drizzle-схема
    token-cipher.ts      # AES-256-GCM
  api/                   # HTTP и WebSocket поверхность
    app.ts               # express-приложение + маппинг ошибок
    sandbox-routes.ts
    strategy-routes.ts
    market-socket.ts     # WS для браузера
    request-validation.ts
    cookies.ts           # ownerCookie, ownerSessionToken
  main.ts                # композиция: env, конструирование, связывание
```

## Матрица направлений импортов

| Откуда \ Куда | core | infra | api |
|---|---|---|---|
| core | ✓ | ✗ | ✗ |
| infra | ✓ | ✓ | ✗ |
| api | ✓ | ✗ | ✓ |

`main.ts` и `test/` импортируют всё. Скрипт `backend/scripts/check-layer-boundaries.mjs` проверяет матрицу и запускается в `npm test`.

## Решения по реализации

- Чистый перенос: имена файлов и публичные типы не меняются, barrel-файлов нет, импорты относительные с суффиксом `.js`.
- Интерфейс `TokenCipher` объявляется в `core/sandbox.ts`; класс в `infra/token-cipher.ts` удовлетворяет ему структурно, без изменений в infra. Инверсия выполняется тем же коммитом, что и перенос `core/`, чтобы ребро core→infra не существовало ни в одной точке истории.
- `auth.ts` разделяется: `OwnerAuth` + `SessionStore` остаются в `core/auth.ts`, хелперы `ownerCookie` и `ownerSessionToken` переезжают в `api/cookies.ts`.
- `InvestSandbox` не разрезается: один класс реализует `Broker`, `SandboxBroker` и `MarketBroker`, один экземпляр переиспользуется в `main.ts`.
- HTTP-статусы внутри `RobotError` и `SandboxError` не выносятся в этом рефакторинге — кандидат в отдельную задачу.
- `drizzle.config.ts` начинает указывать на `./src/infra/db/schema.ts`; существующие миграции не пересоздаются.
- Порядок работ — до задач 06–09 серфинга: они пишутся поверх чистых слоёв.

## Тестирование

- После каждого коммита `npm run typecheck` и `npm test` в `backend/` зелёные.
- Скрипт границы покрывает полную матрицу: core не импортирует infra/api; api не импортирует infra; infra не импортирует api. Нарушение валит `npm test`.
- Существующие тесты не переписываются — только пути импортов.

## Вне рамок

- Вынос HTTP-статусов из доменных ошибок, разрезание `InvestSandbox`, алиасы путей (`#core/...`), вынос композиции из `app.ts`, `GLOSSARY.md`, изменения REST/WS-контрактов.

## Примечания

- Решение фиксируется в `docs/adr/0001-backend-layering.md` и пунктом в `AGENTS.md` (раздел Trading code).
- Спецификация фиксирует согласованные решения Q1–Q15 гриллинга от 2026-11-18.
