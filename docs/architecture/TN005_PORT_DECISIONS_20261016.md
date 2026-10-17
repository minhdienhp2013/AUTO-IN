# TN005 first-page advisory Port — AI0 candidate

Source: AI3 PR120 HEAD `77d94ef3c0160168d3dad3a02d555e9df3827756` and
`TN005_FIRST_PAGE_CLASSIFICATION_20261016.md` on AI0 PR112.

- Simulation-only authenticated staff entry:
  `POST /internal/simulation/orders/:order_id/revisions/:revision/first-page-suggestion`.
  It accepts no hash, filename, source path or OCR content from the caller.
- AI0 binds shop from the bearer principal, current Core order/revision/request_hash,
  one completed inbound event, verified customer/conversation, immutable upload
  manifest and SHA-256. Only that private sealed source is supplied to AI3.
- Python runs in a separate process with a 10-second parent kill deadline,
  512 MiB POSIX address-space limit, 8 CPU seconds, 25 MiB source limit and
  4 KiB stdout limit. No stderr, source text or exception details are emitted.
  Unsupported worker platforms fail closed.
- A second hash read precedes the database write. The INSERT checks the active
  revision, request hash and linked artifact hash/ref while locking the Core
  order row. The advisory table is keyed by shop/order/revision; it has no
  print state or approval columns. A later revision makes the earlier hint stale.
- A same-revision replay returns the stored suggestion after source verification.
  The output contains category/status/confidence/page count/method/reason only.
  UNKNOWN and NEEDS_HUMAN do not imply print readiness or customer confirmation.

This Port exposes an integration boundary; it is not yet scheduled after every
verified upload or connected to AI2 customer questions. That next composition
step needs an explicit trigger and independent same-SHA acceptance. No live OA,
external AI, native Word page boundary, print driver or real customer file is
used by this candidate.

## AI2 question preview follow-up

AI2 PR126 supplies a pure whitelist-only question formatter. The next AI0
candidate imports its two blobs unchanged and adds a staff-authenticated,
simulation-only GET `.../first-page-question` preview. AI0 derives customer,
conversation and OA identity from the order and completed inbound draft; the
client supplies only an order/revision selector. A repeatable-read PostgreSQL
snapshot binds Core revision/hash, registered sealed source and stored advisory.
The source manifest and bytes are verified through that snapshot, followed by
a fresh revision/hash/source check before returning a suggested category.
Missing, stale, tampered or uncertain evidence yields the fixed generic
question. This preview never queues or sends a message.

Automatic AI2 outbound wiring is still NOT RUN. Before a later enqueue, AI0
must atomically recheck shop/order/current revision/request hash/sealed source
SHA and conversation AI generation in the outbox transaction. A preview read
cannot authorize a later send after a revision or handover race.

## TN005 sealed-source CAS composition follow-up — 2026-10-17

- Candidate imports the AI1 CAS outbox and the AI2 fail-closed CAS contract
  unchanged from their Draft PRs. AI0 composition adds
  `createVerifiedSyntheticTn005Outbox`; it fixes shop/OA from trusted server
  configuration and calls `verifiedSyntheticSource` for the registered
  manifest, sealed bytes and SHA at each Core enqueue/reserve/delivery check.
- The composition adapter does not register an HTTP route, connect an AI2
  customer-question pipeline, or create a live sender. The integration test
  creates the order through Fastify and exercises only an in-process fake
  sender against isolated PostgreSQL. Exact-SHA PostgreSQL acceptance is
  required before this Port is considered passed or AI2 wiring is assigned.
- The outbox remains advisory only. No READY, customer-confirmation, approval,
  or print authority changes. Provider I/O, OA, real printing and TN037 remain
  NOT RUN.
