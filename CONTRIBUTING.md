# Contributing to Recat

Thanks for helping! Recat writes to people's real accounting ledgers, so the bar is:
**correctness over features**. A bug that silently miscategorizes is worse than a crash.

## Getting a dev environment

```bash
git clone <repo-url> && cd recat
npm install
createdb recat                       # or point DATABASE_URL anywhere
cp .env.example .env                 # set SESSION_SECRET + ENCRYPTION_KEY, QBO_MOCK=true
npx prisma migrate dev
npm run seed                         # demo data (2 mock companies)
npm run dev                          # server :3001 + client :5173
```

With `QBO_MOCK=true` you get a built-in fake QuickBooks with two demo companies —
no Intuit account needed. Sign in with any email; the magic link prints to the
server console (and appears as a one-click shortcut in the UI).

The fake QuickBooks persists its state in the database (`AppConfig` rows), so
posts/undos survive restarts like the real thing. If you wipe the database to
reseed, **restart the dev server** afterwards — its in-memory copy of the mock
realm is stale until then.

To develop against real QuickBooks, create sandbox keys per
[docs/intuit-setup.md](docs/intuit-setup.md) and set `QBO_MOCK=false`.

## Ground rules

- TypeScript strict everywhere; no `any`.
- Every DB query scoped by `companyId` — a missing scope is a security bug.
- Never write to QBO without a fresh read (`SyncToken` discipline).
- Every QBO write goes through the audit log, in the same DB transaction.
- `DRY_RUN` / per-company dry-run must be respected by every write path.
- The audit log is append-only. No update/delete paths, ever.

## Tests

```bash
npm test              # server unit tests (vitest)
npm run typecheck     # all workspaces
```

Add tests for anything touching the write-back path, suggestion pipeline,
transfer detection, or splits math.

## Pull requests

- Keep PRs focused; describe the user-visible behavior change.
- The UI follows a deliberate, settled design system (tokens in
  `client/src/styles/global.css`, screenshots in `docs/screenshots/`) —
  match the existing screens' spacing, type, and color tokens exactly.
- Update `docs/decisions.md` if you make a judgment call the docs don't cover.

## License

By contributing you agree your work is licensed under AGPL-3.0-only.
