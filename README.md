# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Design Decisions

### 1. Why database uniqueness is needed

`idempotency_keys` has a `UNIQUE (tenant_id, operation, key)` constraint. The
claim itself is a single `INSERT ... ON CONFLICT ... RETURNING *`, so the
database — not application code — decides which of any number of concurrent
requests wins. Only the transaction that inserts (or reclaims an expired) row
proceeds to create the incident; every other request, sequential or
concurrent, sees the conflict and is routed to replay/conflict handling
instead. Locking in application code (mutexes, advisory locks scoped to a
single process) cannot make this guarantee across multiple app instances;
the unique index is enforced by Postgres for every connection, everywhere.

### 2. Canonicalization and comparison

`hashRequest` (`src/incidents.js`) serializes the JSON body with object keys
sorted recursively at every level, then SHA-256-hashes the result. This
means `{"a":1,"b":2}` and `{"b":2,"a":1}` hash identically, so key reuse
isn't rejected over incidental client-side property reordering, while any
change to an actual field value or shape produces a different hash. The
stored `request_hash` is compared on every reuse of a key: a match confirms
"same logical request" and is eligible for replay; a mismatch means the
client reused a key for a different request body and gets
`409 idempotency_key_conflict` instead of silently returning the old result.

### 3. What the 24-hour expiry means

`expires_at` is set to `now() + interval '24 hours'` when a key is claimed.
It does not mean "the incident disappears" — the incident and paging job
are permanent business records. It means the *idempotency guarantee* is
scoped to a 24-hour deduplication window: a client is expected to retry a
given logical operation (with the same key) within that window to get exact
replay/duplicate protection. After expiry, the same key can be legally
reclaimed by a brand-new request with a fresh hash and state (see the
`ON CONFLICT ... WHERE idempotency_keys.expires_at < now()` clause), so keys
don't have to be retained, and reclaimed, forever. This is an exercise-scale
value chosen to bound storage growth and match common industry defaults
(e.g., payment-processor idempotency windows); a production system might
tune it per operation.

### 4. Why the paging job is written in the same transaction

The incident row and its paging job row are inserted in the same
`db.tx(...)` block, alongside the update that marks the idempotency key
`completed`. If any part fails (bad severity value, connection drop,
constraint violation), the whole transaction rolls back: no orphaned
incident without a paging job, no paging job without an incident, and no
key left claiming success for work that didn't happen. The *job* is durably
recorded in this transaction, not *executed* — the actual paging
provider/queue call is intentionally left for a separate worker to pick up
the `pending` row later, so a slow or flaky external call never holds a
database transaction open or gets retried into duplicate pages.

### 5. Privacy and size risks of stored responses

`response_body` (JSONB) stores the full incident (title, severity, tenant
and service IDs) so a replay can return byte-for-byte the original result.
Two risks follow directly from that: **privacy** — anything written into an
incident title/body becomes data at rest inside the idempotency table too,
so it's subject to the same retention/redaction/access-control rules as the
`incidents` table itself, and should not be extended to include secrets
(auth tokens, PII beyond what's already legitimately in the incident) that
wouldn't otherwise be stored; and **size** — an unbounded response body
(e.g., if this pattern were reused for endpoints that return large
payloads) turns every replay-capable endpoint into a place where large
blobs pile up for 24 hours per unique key. The expiry keeps this bounded,
but a production system handling larger payloads would want either a size
cap on what gets stored, or storing a stable pointer/summary instead of the
full response body.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
