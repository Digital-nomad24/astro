# Astro — conventions

Mentor consultation platform. Users browse mentors and start a live **voice call or text
chat**, billed per minute from a prepaid wallet. Busy mentors have a queue.

This file is tracked on purpose. The repo this one's conventions came from kept its rules in
an untracked `.cursor/` directory, so nobody but the original author ever saw them.

## Getting started

We run on **managed services** — nothing self-hosted. Provision a Postgres, a Redis, a
Firebase project and a LiveKit Cloud project, then:

```bash
npm install
cp apps/astro-api/.env.example apps/astro-api/.env   # fill in every <PLACEHOLDER>
npm run db:migrate
npm run dev               # http://localhost:3000, /docs for Swagger
```

Three things that bite on first setup:

- **`DATABASE_URL` must be the direct/session-mode string**, not the pooled one. The app
  refuses to boot on a `-pooler` host, port 6543, or `?pgbouncer=true`.
- **`REDIS_URL` must be a TCP endpoint** (`rediss://…`), not Upstash's REST URL. REST cannot
  do pub/sub or `EVALSHA`, and this app needs both.
- **LiveKit Cloud cannot POST webhooks to localhost.** From M4 the session lifecycle is
  webhook-driven, so local work needs a tunnel —
  `cloudflared tunnel --url http://localhost:3000`, then point the LiveKit project's webhook
  URL at `https://<tunnel-host>/webhooks/livekit`.

A fully local, zero-GCP alternative still exists if you want it: `npm run infra:up`
(Postgres + Redis + LiveKit via docker compose) and `npm run emu:auth` (Firebase Auth
Emulator), with the commented local values in `.env.example`.

## Layout

```
apps/astro-api/src/app/<domain>/     one Nest app, DDD domain folders — NOT microservices
libs/astro-service/<tier>/<name>/    shared libs, built to dist/, consumed as npm workspaces
```

Every domain folder:

```
<domain>/
├── contracts/                       re-export the @astro/contracts slice for this domain
├── domain/{entities,repos}          repo INTERFACES + Symbol DI tokens; no Nest, no Prisma
├── application/{use-cases,services,schedulers}
├── entry-points/{http,sockets}      controllers, gateways, DTOs
├── infra/{db/prisma/repos,redis}    port implementations
├── tokens.ts                        Symbol DI tokens
└── <domain>.module.ts
```

## Rules

**Dependency direction.** Use cases inject `I*Repo` via `@Inject(TOKEN)` — never
`PrismaService` directly. Cross-domain calls go use-case → another domain's *application
service*; never another domain's repository, and never another domain's use case from a
controller.

**Errors.** Domain and application code throws `DomainError` subclasses from `@astro/errors`
(`NotFoundError`, `ConflictError`, `UnprocessableError`, …). `AllExceptionsFilter` maps them
to HTTP. Only `entry-points/http` may throw Nest's `HttpException`. `code` is the stable
contract with clients; `message` is for humans and may change freely.

**Money.** Integer paise, always. Never a float, never `Decimal`. Fields are suffixed
`Paise`. The ledger invariant is `SUM(WalletLedger.amountPaise) == Wallet.balancePaise`,
exactly — every debit inserts the ledger row and decrements the balance in **one**
`$transaction`. `BigInt` columns must be mapped to `Number` in the repo mapper;
`JSON.stringify(1n)` throws.

**Idempotency.** The house primitive is `createMany({ data: [...], skipDuplicates: true })`
against a `@@unique` constraint, reading `result.count > 0` as "this was the first time".
For state transitions, a conditional `updateMany` scoped to the expected prior status is a
compare-and-swap: `count === 0` means someone else won the race. Never read-then-write.
The third shape is **stamp-only-if-null** — `updateMany({ where: { id, field: null } })` —
used for `billingAnchorAt` and the consent columns, where a repeat must not *move* a value
that has already been set.

**Sessions.** The state machine is a table in `domain/entities/session.state-machine.ts`, and
every transition goes through the repo's `transition()` CAS. Order is fixed and load-bearing:
**DB row first, then the LiveKit room; DB row settled first, then the room closed.** A session
with no room is recoverable by the sweeper; a room with no session is an invisible billable
resource, and a LiveKit outage must never strand a user behind their own in-flight index.
`CANCELLED` means the session never became ACTIVE, `COMPLETED` that it did, `FAILED` that
something broke — `terminalStatusFor()` is what keeps an end reason from filing an ACTIVE
session as if it never happened.

**Webhooks.** The contract is **verify → persist to the inbox → return 200 → process**. The
200 is what stops the provider retrying, so it may only be sent once the event is durable;
processing happens after, and anything that dies in between is picked up by
`WebhookRetryScheduler`, because nothing else will. Three traps, all of them silent:
`Content-Type: application/webhook+json` (Express's default JSON parser ignores it and hands
you an empty body), the signature being over the exact bytes (`rawBody: true`, never
re-serialise), and the global `ValidationPipe` 400ing on provider fields — so the controller
takes `@Req()` only, with no DTO.

**Session economics are frozen at creation.** `Session.ratePaisePerMinute` and
`Session.platformFeeBps` are columns, not reads of `MentorProfile`. Nothing in the billing
path may read `MentorProfile` — a mentor changing their rate must not reprice a live call or
rewrite history.

**Every `@Cron` takes a leader lock** (`LeaderLockService.withLock`). We deploy up to 20
instances; an unlocked billing sweeper is 20× the intended charge. The lock prevents
redundant work — it is not the correctness boundary. Write every task so two concurrent runs
would still be correct (DB constraints), then use the lock so they usually do not happen.

**Socket gateways.** Own `@UsePipes(ValidationPipe)` — the global pipe does not reach
WebSocket payloads. Two-phase handshake: the server emits `<ns>:ready` after auth, and the
client may not join before it. Handlers **return** a discriminated-union ack
(`{ ok: true } | { ok: false, error }`) and never throw — a thrown error is invisible to the
client. Emits are cluster-wide (`server.to(...)`); do not use `.local` unless every instance
independently recomputes identical state, which nothing here does.

**Clients share one Socket.IO `Manager`** across `/presence`, `/calls` and `/chat`. Cloud Run
counts the transport, not the namespace, so three bare `io()` calls triple the concurrency
bill for nothing.

**Auth.** Global `APP_GUARD`; opt out with `@Public()`, restrict with `@Roles()`, read the
caller with `@CurrentUser()`. There is no `POST /auth/sync` — the guard provisions the
shadow row. An e2e test enumerates every route and fails if one is neither public nor
guarded.

**No credentials on disk.** Production uses ADC; local uses the Auth Emulator. If you find
yourself adding a service-account JSON, stop.

**`DATABASE_URL` must be a direct connection.** Prisma interactive transactions break against
a transaction-mode pooler, and only under concurrency — i.e. only in production. The env
schema refuses to boot against one.

## Nx

Nx is a task runner and cache, nothing more: no plugins, every target is `nx:run-commands`
wrapping `nest build` / `tsc`. `tsconfig.base.json` has **no `paths`** — libs resolve as real
npm workspace packages through `node_modules/@astro/*` symlinks pointing at `libs/*/dist`.

The consequence: **editing a lib does not update the app's types until that lib is rebuilt.**
Either run `npm run libs:watch` alongside `npm run dev`, or `npm run libs:build` after
changing a lib. `declarationMap` is on, so go-to-definition still lands in lib source.

Adding a lib means updating three places: root `package.json` `workspaces`, the lib's own
`project.json`, and `apps/astro-api/project.json` `dependsOn`.

## Prisma

Prisma 7 with `prisma.config.ts` and a split schema directory — one model per file under
`apps/astro-api/prisma/models/`. Ids are `String @id @default(cuid())`; join and ledger
tables use a composite `@@id`. No `@@map`, no soft deletes. Durable ledger rows keep parent
ids as **no-FK scalars** so history survives deletion of what it refers to.

Prisma enums must stay byte-identical to the `as const` arrays in
`libs/astro-service/shared/contracts/src/lib/enums.ts`. Nothing enforces this; a drift is a
runtime error.

**Partial indexes and CHECK constraints are hand-written in the migration SQL**, because
Prisma can express neither — the in-flight session uniqueness, the positive-rate checks and
the "a terminal session has a reason" check all live there. Prisma *does* model indexes, so a
later `migrate dev` will happily propose `DROP INDEX` on one it never declared; delete those
lines from the generated migration. `test/schema-invariants.e2e-spec.ts` asserts every one of
them against `pg_indexes` and `pg_constraint` — and that two of them actually reject a bad
row — so a migration that removes one fails a test rather than a production invariant.
`npm run db:check-invariants` prints the current set.

If you hand-edit a migration *after* it has been applied, its recorded checksum no longer
matches and `migrate dev` will refuse to run. Update `_prisma_migrations.checksum` to the
sha256 of the file rather than resetting the database.

Migrations are applied by a Cloud Build step **before** the new revision deploys, so a bad
migration fails the release instead of shipping code that expects a schema which is not there.

## Milestones

M0 scaffold ✅ · M1 auth ✅ · M2 mentors ✅ · M3 presence ✅ · M4 LiveKit voice ✅ ·
M5 text chat ✅ · M6 queue ✅ · M7 reviews ✅ · M8 session summaries · M9 mentor dashboard ·
**M10 wallet + billing (the money path, last)** · M11 harden + ship.

Sessions are metered but not charged before M10: `billingAnchorAt`, `endedAt` and the frozen
rate are written from M4/M5 so the ledger can be layered on without touching the session
lifecycle. Until M10 the only stop on a running session is `SESSION_MAX_DURATION_S`.

## Ratings

`MentorProfile.ratingSum/Count/Avg` is a **cache of `Review`**, and `ratingAvg` is a browse
sort key — so a window in which the two disagree is a window in which mentors are ranked
wrongly on the hottest read path in the product. The review write and the aggregate update are
therefore one transaction, always, including admin hide/unhide.

The aggregate update is raw SQL because Prisma can express `{ increment }` but not "set this
column to a function of the columns you just incremented". Doing it in two statements
reintroduces the read-modify-write it exists to avoid.

`RatingReconciler` runs nightly and should report **zero corrections**. It is a detector first
and a repair second: a non-zero count means something wrote outside the transaction, and
correcting the number does not stop that recurring — so it logs at `warn`.

## The queue

**Redis answers "what is my position"; Postgres answers "who waited and how did they leave".**
Neither is a cache of the other. Ordering lives in a per-mentor `ZSET` scored by *enqueue time
in ms* — one choice that buys stable FIFO, exact-place rollback after a lost race, and expiry
as a range query. `QueueEntry` is the durable record, and `QueueReconciler` rebuilds the sorted
set from it at the original scores, so a `FLUSHDB` reshuffles nothing.

**The Lua dispatch lock makes the race rare; `session_one_inflight_per_mentor` makes losing it
harmless.** `ZPOPMIN` alone is not enough — it stops two instances popping the same member, not
two instances each popping a *different* member against one free mentor. The loser catches
23505 and is reinstated at its original score.

**Availability is read from the session table, not from presence.** `presenceState` only turns
BUSY on accept, so a mentor whose phone is ringing still reads ONLINE. Presence is a read-model
for browse cards; `findInflightForMentor` is the fact.

The two user-facing indexes are scoped differently and deliberately so:
`session_one_inflight_per_user` includes QUEUED (one place in one line, not one in every line);
`session_one_inflight_per_mentor` excludes it (many people queue for one mentor).

The queue depends on sessions, never the reverse — `QueueService` registers itself through the
`ISessionQueue` port at init. Drop `QueueModule` from `AppModule` and a busy mentor is a 409
again, exactly as in M4.

## Chat transcripts are temporary

A text consultation's messages are **working data, not the record**. The durable artefact is
the summary; `ChatMessage` rows are deleted once they have served their purpose.

```
session ends ──▶ retained CHAT_RETENTION_DAYS (7) ──▶ summarised (M8) ──▶ messages deleted
                          └──────────────── CHAT_HARD_DELETE_DAYS (30) ────────────┘
                                        (deleted regardless, summary or not)
```

**Delete-on-summarise plus a hard backstop — both, not either.** Delete-on-summarise alone
leaks every transcript whose summary failed, forever. A backstop alone destroys content before
anything has read it. Same shape as the audio retention, for the same reasons.

What survives a purge is deliberate: the summary, `Session.messageCount`, `billingAnchorAt`,
and who spoke to whom. `messagesPurgedAt` is what lets a client tell "the transcript was
deleted" from "nobody said anything" — the same empty array otherwise, and a UI that confuses
them shows a blank pane for a consultation that definitely happened.

**Until M8 ships nothing can be summarised**, so every completed chat reaches the 30-day
backstop un-summarised and is deleted unread. `ChatRetentionScheduler` logs that case at
`warn`. Raise `CHAT_HARD_DELETE_DAYS` if M8 slips well past a month.

A purge does not make a summary non-sensitive: it is still personal data with its own
retention and access rules. This reduces the obligation; it does not remove it.

## Session summaries

Every completed session gets an LLM summary — text from the `ChatMessage` log, voice from the
recording. Voice runs LiveKit Egress → GCS → **Gemini reading the audio directly** (there is
no STT stage) → summary → delete the audio. Retention is delete-on-success *plus* a 48h
lifecycle backstop, so a transient failure is retryable but audio is normally gone in minutes.

Three rules that are not negotiable:

- **Consent gates `StartEgress`, not the summary.** No consent from either party → no
  recording, and the session runs normally without a summary. A recording taken without
  consent cannot be un-taken.
- **Egress failure never touches the call.** Log it, mark the session summary-ineligible,
  carry on.
- **The summarization job is idempotent** the same way the ledger is: `SessionSummary` unique
  on `sessionId`, an explicit status, an attempt counter, and a dead-letter — otherwise a
  poison recording retries until the lifecycle rule deletes it.

Deleting the audio does not make the summary non-sensitive; it is still personal data with
its own retention and access rules.
