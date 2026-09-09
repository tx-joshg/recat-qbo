---
last_edited: 2026-09-09
---

# Two-state rule rollout

This is a release checklist, not authorization to change production. Do not run
the commands against a live company until its operator approves the release,
backup, maintenance window, and exact source/image versions. Never use a real
QuickBooks company as a test fixture.

## Release gates

- Record the source commit, immutable candidate image digest, previous image
  digest, database backup identifier, restore-test evidence, and company UUID.
- Complete typecheck, unit/client tests, PostgreSQL 17 tests, and the production
  build for that exact source. PostgreSQL suites must actually run, not skip for
  lack of `TEST_DATABASE_URL`.
- Verify the actual previous binary against a disposable copy of the expanded
  schema and rollback-guarded data. Tests that emulate old inserts are useful
  but do not replace this acceptance check.
- Verify all rule consumers honor the durable company runtime mode, including
  sync, suggestions, manual application, agent snapshots, candidate activation,
  auto-post creation, and restart/reconciliation paths. Do not enable canonical
  mode while any full-action or recovery integration remains incomplete.
- Keep operator credentials bounded to the approved environment. Do not copy
  production secrets, database contents, or customer receipts to a test runner.

## Ordered cutover

1. **Back up and test restoration.** Retain both old and new image digests.
2. **Apply additive migrations.** Expansion must not change rule actions or
   pointers. The app Docker entrypoint runs `prisma migrate deploy` before boot;
   account for this when scheduling the release. Do not remove historical
   retirement values, revision rows, or old immutable operation payloads.
3. **Deploy the complete compatible release.** Existing companies retain their
   `legacy`, `bridge`, or `paused` mode until explicit activation. Rules reads
   expose that mode; the Rules page explains the pending migration and disables
   new mutations. Legacy rules do not execute through the canonical write path.
   New companies created by the connection wizard start in `canonical` mode;
   reconnecting an existing company preserves its mode.
4. **Quiesce workers and resolve in-flight work.** Stop ingress that can prepare
   new writes and quiesce every worker instance for the cutover window. The
   activation command refuses unexpired uncommitted rule operations, active
   auto-post preparations, POSTING transactions, and PREPARED/COMMITTING/UNCERTAIN
   mutation attempts. It does not cancel, erase, reconcile, or send those writes.
   Resolve them through their existing recovery paths before trying again.
5. **Preview explicit activation.** Run the `--activate --dry-run` command below
   from the company's current mode. Retain its JSON report and review every
   disabled proposal, repair reason, Journal Entry hold, inferred direction,
   priority, and tax action. Dry-run changes neither data nor runtime mode.
6. **Apply the reviewed migration and activate atomically.** The explicit
   `--activate --apply` command uses the existing SERIALIZABLE table and company
   advisory fence to validate references, append revisions and migration
   markers, advance live pointers by compare-and-swap, clear rule snapshots,
   and finally set `canonical`. All changes commit together; any failure leaves
   the original mode and data intact. No hand-written SQL is needed for this
   upgrade. History/AI hints and immutable old history remain intact.
   This guarantee applies to activation itself. Later syncs follow the existing
   refresh behavior: unavailable or disabled AI, or no eligible AI result, can
   leave a transaction without an AI hint.
7. **Verify before resuming.** Re-run `--activate --dry-run` immediately: expect
   zero proposed migrations, revisions, and markers and `runtimeModeAfter` equal
   to `canonical`. Compare applied counts with the preview. Check priority ties,
   Purchase, Deposit, no-tax and taxed actions, disabled/held rules, and Journal
   Entries (never executable). Then resume compatible workers and observe
   recovery before allowing new auto-post work. Verify the exact release in
   Chrome, including Rules status/history, complete-action Queue staging,
   recovery controls, and AI/history hints. Production posting requires separate
   approval.

The cutover lock spans shared rule/reference/transaction tables, even though the
data operation is company-scoped. Schedule a maintenance window accordingly.
Lock contention retries with a fresh transaction and fails after approximately
30 seconds. On a failure, inspect the error and keep workers quiesced; do not
weaken locking or bypass validation to make deployment proceed.

## Commands

Run from the repository root using the built, verified server artifact, with
`DATABASE_URL` already injected for the explicitly approved environment. Replace
the placeholders with a company UUID and a nonblank operator identifier (at
most 128 characters); do not place credentials in command arguments.

```sh
npm run rules:canonical-backfill -w server -- --company-id <company-uuid> --actor <operator-id> --activate --dry-run
npm run rules:canonical-backfill -w server -- --company-id <company-uuid> --actor <operator-id> --activate --apply
npm run rules:canonical-backfill -w server -- --company-id <company-uuid> --actor <operator-id> --activate --dry-run
```

Without `--activate`, the backfill retains its original paused-only behavior and
never changes runtime mode. `--activate` is rejected by the rollback command.
Omitting an execution mode defaults to dry-run; specify it explicitly in release logs.
Unknown or repeated flags are errors. The report distinguishes `would*` counts
from actual writes, including `wouldMigrateRules`/`migratedRules`,
`wouldAppendRevisions`/`appendedRevisions`, `wouldCreateMarkers`/`createdMarkers`,
and `wouldClearRuleSuggestions`/`clearedRuleSuggestions`.

Partial migration markers, unmarked canonical rows, or mismatched live/history
pointers are hard stops. Retain the report and investigate; do not hand-edit
markers or immutable history. This is a controlled legacy-company migration,
not a general repair command for an already active company with newly created
canonical rules.

## Fail-closed rollback

Do not start an older binary merely because the schema remains compatible.
An older rule consumer can misinterpret complete tax/direction actions as
category-only instructions.

1. Block new rule operations and resolve outstanding work. Keep all workers
   quiesced. Unlike activation, rollback still requires an explicit durable pause
   through the deployment’s controlled database administration process: set the
   exact company’s `Company.ruleRuntimeMode` to `paused` and verify it. The
   `--activate` option does not perform this rollback pause.
2. With the compatible current artifact, preview and apply the rollback guard:

   ```sh
   npm run rules:rollback-guard -w server -- --company-id <company-uuid> --actor <operator-id> --dry-run
   npm run rules:rollback-guard -w server -- --company-id <company-uuid> --actor <operator-id> --apply
   npm run rules:rollback-guard -w server -- --company-id <company-uuid> --actor <operator-id> --dry-run
   ```

3. Verify every canonical rule is disabled with auto-post off and no pending
   rule-sourced suggestion remains. Retain the guard's appended revisions,
   audits, repair reasons, and existing tombstones. The final dry-run should
   propose no further disabling or suggestion clearing.
4. Confirm the target binary's disposable acceptance proof covers taxable
   Purchase and Deposit actions, manual suggestions, auto-post, and inability
   to reactivate migrated retired rules. Do not restore access to unsafe legacy
   rule mutation endpoints. If this cannot be established, keep workers paused
   and use a patched compatible rollback binary instead.
5. Only then replace the binary. Keep the additive schema and audit history;
   do not run a destructive down migration. Re-enable workers only after the
   operator verifies the guarded target cannot execute those rules.

Reactivation is a separate reviewed action on a compatible release, never an
automatic side effect of rollback or backfill. A later schema contraction needs
its own review after the rollback window and must preserve immutable history.

## Verified manual decisions

A new browser commit records the authenticated user’s approval of the exact staged action. It does not assert a researched rationale, tax jurisdiction, or citations. Currency comes from the cached QuickBooks CurrencyRef; absent or invalid currency is represented as XXX. Existing attempts keep their original decision envelope, including the absence of one. Legacy status-only posting does not create a verified classification case.

Verified attempts whose local classification fold was interrupted are rediscovered after restart in bounded local batches. This recovery reads persisted verification evidence and does not send QuickBooks writes.
