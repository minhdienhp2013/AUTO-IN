# AI1 — controlled_test grant V1

## Provisioning boundary

V1 has no public grant endpoint and does not use manual SQL. The only application path is the private operator command `npm run core:controlled-test-grant -- <request-file>`. It accepts one owner-only JSON file, connects with `DATABASE_URL`, and requires `AUTOIN_CONTROLLED_TEST_OPERATOR_ROLE` to match PostgreSQL `session_user`. Do not put the database URL or credentials in the request file or command line.

Before creating a grant, the owner confirms the exact shop, current order, printer and short test window in an operations ticket. An authorized operator creates a mode-0600 request file and runs the command from the controlled operations environment. The command verifies the active owner belongs to the shop and the order has a current revision, serializes changes by locking the shop/order/owner, and creates the grant, enables only that shop's controlled mode and writes `core_audit` in one transaction. Any failed check or audit insert rolls back the whole transaction. The audit actor is the owner; details include the ticket reference, expiry and database operator role. It stores no customer code, credential, document bytes, path, URL or document content.

Example request shape (values come from the owner-approved ticket):

```json
{"action":"grant","shop_id":"shop-id","order_id":"00000000-0000-4000-8000-000000000001","printer_id":"RMP7000","owner_id":"00000000-0000-4000-8000-000000000002","ttl_seconds":900,"ticket_ref":"OPS-123"}
```

Use `{"action":"revoke","shop_id":"…","order_id":"…","printer_id":"…","ticket_ref":"OPS-124"}` to revoke. Revocation works if the grantor is no longer active, records the operator role in `core_audit`, and returns the shop to `simulation` with printing disabled when no other active grant remains. The command is intentionally not registered in HTTP routes.

## Core enforcement

- Grants are absent by default. `core_shop_settings` defaults to `simulation` with `printing_enabled=false`; scope rows default to `enabled=false`.
- A grant covers one exact shop/order/printer tuple, requires an active owner in that shop, and lasts 1–1,800 seconds. The expiry is created from PostgreSQL `clock_timestamp()`; caller-supplied timestamps are not accepted by the command.
- Core rejects future `updated_at`, expired grants and any expiry more than 30 minutes after `updated_at`. Queue selection and claim, preflight and mark-sending recheck the same owner/scope conditions. Controlled claims also receive the exact order from server composition; the Agent cannot choose or widen it.
- The operator command will not extend an active grant or silently switch a shop already outside `simulation`/OFF into the pilot. A fresh owner-approved ticket is required for a later grant.
- `UNKNOWN` remains unrecoverable by automatic claim. Revocation after `SENDING` cannot undo a request already sent; it blocks later authorization and never permits resend.

If the trusted operator database role, owner approval ticket or private command environment is unavailable, keep `AUTO_IN_MODE=simulation`, `AUTOIN_PILOT_CONTROLLED_TEST_ENABLED=0`, and printing disabled. Do not replace the command with direct SQL or a public endpoint. The ticket records the human approval; the command verifies the owner account and records the operator action but does not cryptographically verify the ticketing system.

The grant is order-level for at most 30 minutes; one-shot-per-revision is not enforced by this schema. The server's controlled pilot scope remains pinned to one order and printer, and the operator must stop after the authorized test. A future one-shot requirement needs a revision/job-bound grant and atomic Core enforcement.
