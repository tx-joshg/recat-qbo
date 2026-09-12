---
last_edited: 2026-09-09
---

# Classification search

Classification search returns bounded evidence from vendor identities and aliases,
verified cases, rules, rule candidates, and historical observations. Historical
observations and foreign-company matches are advisory. Search does not call
QuickBooks or post transactions; existing preparation and write checks still
control every accounting change.

The company-scoped endpoint is
`GET /api/companies/:companyId/classification/search`. Supply `query` and an
explicit `mode`: `exact`, `lexical`, `semantic`, `hybrid`, or `auto`. Results include
provenance, conflicts, the effective mode, and an explicit `no_match` status when
no evidence matches. An optional owned `transactionId` supplies transaction context
and excludes that transaction from its own evidence.

The default scope is `current_company`. `accessible_companies` refreshes actual
memberships and removes foreign QuickBooks action identifiers. Pagination cursors
are bound to the user, company, query, selected transaction, membership set, and
corpus snapshot. Restart pagination when a cursor becomes stale.

## Optional semantic retrieval

Lexical and exact search work without an embedding provider. To enable semantic
retrieval, install pgvector in the application's PostgreSQL database and inject
`VOYAGE_API_KEY` through the deployment's secret configuration. The optional
`CLASSIFICATION_EMBEDDING_BASE_URL`, `CLASSIFICATION_EMBEDDING_TIMEOUT_MS`,
`CLASSIFICATION_EMBEDDING_BATCH_SIZE`, and
`CLASSIFICATION_EMBEDDING_FINGERPRINT_SALT` settings are documented in `.env.example`.
Never put the API key in a checked-in environment file.

The scheduler performs bounded embedding work at boot and at most once every ten
minutes. Company batches rotate in ID order within the running process; a restart
resets the batch position. Vector schema installation is shared by the database
client; subsequent readiness checks probe extension availability without running
DDL. If vector tables are manually removed while the extension remains installed,
restart the application after restoring the database. Invalid embedding settings
produce a bounded `invalid_configuration` readiness diagnostic.

A replacement embedding generation becomes active only after all of its
required chunks are available. Recipe changes and corpus revisions invalidate
stale derived results.

When embeddings are unavailable, `auto` returns labelled lexical degradation.
Explicit `semantic` and `hybrid` requests return `SEMANTIC_UNAVAILABLE` rather than
claiming semantic coverage. Signed-in company viewers can inspect readiness at
`GET /api/companies/:companyId/health/classification-search`; the response excludes
provider credentials and raw provider bodies.

The MCP `search_classification_knowledge` tool uses the same company reads and
bounded response contract. Agent search tools use current-company evidence and
retain the existing scheduling, approval, and verified-write guards.
