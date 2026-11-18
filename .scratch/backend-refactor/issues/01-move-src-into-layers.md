# 01: Перенос модулей по слоям

Status: ready-for-agent

**Что сделать:** Разнести плоский `backend/src/` по слоям `core/`, `infra/`, `api/` без изменения поведения: перенести файлы, обновить относительные импорты в `src/` и `test/`, разделить `auth.ts` (cookie-хелперы → `api/cookies.ts`), обновить путь схемы в `drizzle.config.ts`.

**Блокируется:** нет. Инверсия `TokenCipher` (задача 02) выполняется тем же коммитом, что и перенос `core/`, чтобы ребро core→infra не существовало ни в одной точке истории.

## Критерии приёмки

- [ ] Шесть доменных файлов лежат в `core/`, четыре адаптера — в `infra/` (схема в `infra/db/`), пять HTTP/WS-модулей и `cookies.ts` — в `api/`; `main.ts` остаётся в корне `src/`.
- [ ] Имена файлов и публичные типы не изменились; barrel-файлов нет.
- [ ] `drizzle.config.ts` указывает на `./src/infra/db/schema.ts`; `db:generate` и `db:check` работают.
- [ ] `npm run typecheck` и `npm test` зелёные; тесты не переписаны, обновлены только пути импортов.
- [ ] `app.ts` и `market-socket.ts` берут `ownerCookie`/`ownerSessionToken` из `api/cookies.js`; в `core/auth.ts` HTTP-концептов нет.
