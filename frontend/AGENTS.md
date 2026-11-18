# Frontend

- Follow Feature-Sliced Design: `app` owns providers and route files, `pages` owns screen-specific code, and `shared` contains reusable infrastructure. Add lower layers only for actual reuse. Cross-slice imports go through public `index.ts` files; use relative imports within a slice and never import a higher layer.
- Keep application React components focused, one component per file. Leave shadcn/ui primitives in the registry's multi-component format when applicable.
- Colocate tests with the utility, component, or screen they cover. Name Playwright tests `*.e2e.ts` so the runner finds them under `src/`.
- Inject endpoint groups into `shared/api`'s `rootApi`. Keep WebSocket subscriptions tied to the relevant RTK Query cache entries.
- Define routes in `src/app/routes`. Vite regenerates `src/app/router/routeTree.gen.ts`; commit the generated tree with route changes so typechecking works without starting Vite.
- Run `npm run lint:architecture`, `npm run build`, and `npm test` from `frontend/`.
