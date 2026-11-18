# AGENTS.md

## Verification

- Use Node.js 24+ and `npm ci`. `npx tsc --noEmit` checks the TypeScript without requiring the Vite app; `npm run build` type-checks first, then runs `vite build`.
- `npm test` uses `tsx` with Node's test runner and matches only `test/*.test.ts`. Run one file with `npx tsx --test test/<name>.test.ts`. With no matching files, `npm test` currently exits successfully with zero tests.
- This checkout has no Vite `index.html` or `src/server/main.ts`. The `dev`, `server`, and `start` scripts do not yet launch a working app. Docker Compose, PostgreSQL migrations, and the broker adapter are specified but not implemented.

## Trading code

- `SPEC-serfing.md` is the agreed sandbox-only MVP, not a description of what's already built. It supersedes `TZ-serfing.md` on first entry, reconnect behavior, and the EMA source.
- `src/server/domain/strategy.ts` contains pure signal and position-delta logic. `src/server/application/robot.ts` owns feed lifecycle and order reconciliation; test public `Robot` behavior with fake `Broker` and `TradingStore` implementations from `src/server/application/ports.ts`, without a token or real hour-long waits.
- Candle `time` is the opening timestamp in milliseconds. Streams and local EMA previews update the chart; orders require a completed candle and broker EMA for that same timestamp. Backfill sets the baseline but never trades, and first entry still requires a confirmed crossing.
- Preserve reserve-before-send ordering through `TradingStore.reserve`. An ambiguous submission is reconciled using the original order ID, not retried as a new order. Stopping the robot does not flatten the position.

## Agent skills

### Issue tracker

Задачи и спецификации хранятся локально в `.scratch/`. См. `docs/agents/issue-tracker.md`.

### Domain docs

Один доменный контекст: корневой `GLOSSARY.md` и `docs/adr/`. См. `docs/agents/domain.md`.
