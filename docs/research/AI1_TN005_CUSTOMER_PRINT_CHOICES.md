# AI1 TN005 customer print-choice evidence

This Core Port is the persistence boundary for explicit customer copies,
paper-size and duplex choices on an adopted, sealed-source order. It is not
connected to AI2, an HTTP route, Zalo outbound, approval or printing.

## Accepted input and verification

`createCustomerPrintChoicePort(...).apply(...)` accepts only the order ID,
expected active revision, request hash, sealed-source SHA, a bounded list of
persisted event IDs and an idempotency key. Extra fields are rejected. The
server factory fixes shop/OA and injects a verified processor plus AI0's
sealed-byte verifier. The Port reloads order/revision, proposal, adoption
receipt, artifact and inbound event rows under a transaction; it verifies the
revision request-data hash, original proposal event, revision-2 staff-adoption
settings hash, current document reference, event scope and actual sealed source.
No caller text or requested print value is used.

The shared literal parser is versioned `vn-print-setting.literal.v1`. Each
persisted text event must parse to exactly one supported value. Multiple events
that set the same field, unclear phrases, or out-of-scope events fail closed.
Accepted values are normalized into the hashed revision data under
`customer_print_choices.fields` and separately persisted with shop, OA,
customer, conversation, order, current revision/hash, source event/SHA, choice
event/revision, origin and parser version.

## Revision and provenance rules

The Port locks the order and compares expected revision, request hash and source
SHA before writing. It creates one new revision with `plan = NULL`, advances
`active_revision`, records reviewed event IDs and appends an evidence batch in
the same transaction. Lost-ack retries return the existing batch; changed
inputs under the same key fail. Existing evidence remains historical on its capture revision. A later capture
validates current evidence but creates a new revision containing only the newly
parsed event values; it does not carry older choices forward. A newer revision
without matching evidence cannot treat older rows as active choices. Stale or
tampered evidence is rejected.

Staff adoption defaults stay in `request_data.documents[]`; this Port leaves
that object untouched and never labels it as a customer choice. Legacy root
`copies`/`paper_size`/`duplex` values without this evidence ledger are not
upgraded into customer provenance.

The Port changes neither customer confirmation nor approval/READY/print state.
It refuses finalized orders and writes no confirmations, approvals, jobs or
ordinary Zalo replies. New revisions require the normal confirmation and
processor/approval path. PostgreSQL integration tests use synthetic source
bytes/events and two independent pools; live OA and printer use remain out of
scope.
