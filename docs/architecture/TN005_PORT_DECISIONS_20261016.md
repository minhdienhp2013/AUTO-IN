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
