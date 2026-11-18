# AGENTS.md

## Verification

- Use Node.js 24+. Install dependencies with `npm ci` and run checks in each application directory once its scripts and lockfile exist.
- Keep `backend/` and `frontend/` independently installable and runnable, with separate environment configuration. REST handles requests and mutations; authenticated WebSocket handles browser live updates. Use RTK Query for server state and Redux Toolkit for shared client state.
- Use Drizzle ORM for backend PostgreSQL access and Drizzle Kit for schema migrations. Commit the generated migration and its metadata together; apply migrations at backend startup.
- Style the frontend with Tailwind CSS via the Vite plugin. Use shadcn/ui components from the frontend's configured registry and shared theme tokens for consistent light and dark styles.

## Trading code

- `.scratch/serfing/spec.md` is the agreed sandbox-only MVP, not a description of what's already built. It supersedes `TZ-serfing.md` on first entry, reconnect behavior, and the EMA source.
- Keep signal and position-delta logic pure. The backend `Robot` owns feed lifecycle and order reconciliation; test its public behavior with fake `Broker` and `TradingStore` implementations, without a token or real hour-long waits.
- Candle `time` is the opening timestamp in milliseconds. Streams and local EMA previews update the chart; orders require a completed candle and broker EMA for that same timestamp. Backfill sets the baseline but never trades, and first entry still requires a confirmed crossing.
- Preserve reserve-before-send ordering through `TradingStore.reserve`. An ambiguous submission is reconciled using the original order ID, not retried as a new order. Stopping the robot does not flatten the position.

## Commits

- Use Conventional Commits: `type(scope): short imperative summary`. Write summaries in English, preferably within 72 characters and without a trailing period.
- Use a scope that identifies the affected area, such as `backend`, `frontend`, `docker`, `db`, or `docs`. Use `app` for cross-cutting changes.
- Use `feat` for capabilities, `fix` for bug fixes, `refactor` for behavior-preserving restructuring, `docs` for documentation, `test` for tests, `build` for tooling and dependencies, and `chore` for other maintenance.
- Keep commits focused. Add a body when the reason or impact needs explaining; use `Refs: serfing/02` (with the actual ticket number) when a local ticket applies. Do not commit secrets or stage unrelated changes.
- Examples: `feat(backend): connect to the trading sandbox`, `fix(docker): isolate dev session cookies`.

## Agent skills

### Issue tracker

Задачи и спецификации хранятся локально в `.scratch/`. См. `docs/agents/issue-tracker.md`.

### Domain docs

Один доменный контекст: корневой `GLOSSARY.md` и `docs/adr/`. См. `docs/agents/domain.md`.
