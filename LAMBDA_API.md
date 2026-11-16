# api-hg — invocation guide

How to call the payments service: deposits through a hosted checkout page and
withdrawals to a bank account (CBU/CVU). Self-contained: nothing here refers
to internal source paths or to the provider behind it.

Two runtimes, one contract:

* **Lambda** — function `${ENV_NAME}-hg-<slug>`, direct `lambda:Invoke`
  with `{ headers, path, query, body }`; the response is the envelope below.
* **HTTP** — the same handlers behind one Node service (Kubernetes). The
  envelope is unwrapped: `data` is the body on success, and a failure is
  `{ errorCode, message, description, detail?, statusCode }` with the HTTP
  status set.

Identity is **only** the caller's platform JWT (`headers.authorization =
"Bearer <jwt>"`). The audience comes from the token's `metadata.partyType`:
`person`/`P` is a player, anything else an operator. Players act on their own
party and wallet account; operators see parties inside their own chain
subtree. The one endpoint without a JWT is the provider webhook, verified by
HMAC.

## Envelope (Lambda)

```jsonc
{ "ok": true, "data": { /* endpoint-specific */ } }
{ "ok": false, "statusCode": 422, "error": { "type": "LIMIT_EXCEEDED", "message": "...", "description": "...", "detail": null } }
```

`error.type` values: `VALIDATION_ERROR` (400), `AUTH_ERROR` (401), `FORBIDDEN`
(403), `ENTITY_NOT_FOUND` (404), `CONFLICT` (409), `INVALID_STATE` (422),
`LIMIT_EXCEEDED` (422), `INSUFFICIENT_FUNDS` (422), `UPSTREAM_ERROR` (502),
`NOT_CONFIGURED` (503), `PAYMENTS_ERROR` (500). A 5xx message is always the
generic "There was an error processing the request".

## Functions

| slug | resource | method | audience |
|---|---|---|---|
| `deposits-create` | `/api/v1/payments/deposits` | POST | player |
| `withdrawals-create` | `/api/v1/payments/withdrawals` | POST | player |
| `withdrawals-cancel` | `/api/v1/payments/withdrawals/{id}/cancel` | POST | player |
| `payments-list` | `/api/v1/payments` | GET | player |
| `payments-get` | `/api/v1/payments/{id}` | GET | player |
| `admin-payments-list` | `/api/v1/payments/admin/payments` | GET | operator |
| `admin-payments-get` | `/api/v1/payments/admin/payments/{id}` | GET | operator |
| `admin-payments-approve` | `/api/v1/payments/admin/payments/{id}/approve` | POST | operator |
| `admin-payments-reject` | `/api/v1/payments/admin/payments/{id}/reject` | POST | operator |
| `admin-settings-get` | `/api/v1/payments/admin/settings` | GET | operator |
| `admin-settings-update` | `/api/v1/payments/admin/settings` | PUT | operator (root only) |
| `admin-reconcile` | `/api/v1/payments/admin/reconcile` | POST | operator |
| `webhook` | `/api/v1/payments/webhook` | POST | provider (HMAC) |

Working payloads are in `tests/events/`.

## The payment object

Every endpoint returns or lists `Payment` objects. Amounts are **major units**
(`1500.50`), in the account's currency.

```jsonc
{
  "id": "3f0c0a2e-...",            // uuid, the only id a caller ever needs
  "kind": "deposit",               // "deposit" | "withdrawal"
  "status": "pending",             // see the two lifecycles below
  "amount": 1500.5,
  "currency": "ARS",
  "fee": null,                     // provider fee once known (withdrawals), else null
  "createdAt": "2026-11-16T10:00:00.000Z",
  "updatedAt": "2026-11-16T10:00:00.000Z",
  "completedAt": null,
  "hold": false,                   // true when it is (or was) waiting for an operator
  "checkoutUrl": "https://...",    // deposits while "pending", else null
  "expiresAt": "2026-11-17T10:00:00.000Z", // deposits, else null
  "destination": { "type": "cvu", "value": "0000003100012345678901", "holderName": "A. Perez" }, // withdrawals, else null
  "note": null                     // operator's reason, present on "rejected"
}
```

To a **player** `destination.value` is masked (`•••• 8901`). To an **operator**
the object also carries: `partyId`, `username`, `chain`, `accountId`,
`walletOperationId`, `walletStatus`, `providerRef`, `providerStatus`,
`payer` (deposits: `{ document, name, email }`), `decidedBy`, `decidedAt`,
`errorCode`.

### Deposit lifecycle

```
pending ──(payer pays)──▶ awaiting_approval ──approve──▶ completed
   │                            │                            ▲
   │                            └──reject──▶ rejected        │
   ├──(hold off)───────────────────────────────────────────────┘
   ├──▶ under_review   (provider asks a human to check the receipt; then completed/rejected)
   ├──▶ expired        (checkout not paid in time)
   └──▶ cancelled      (checkout cancelled)
```

Money reaches the wallet balance **only** at `completed`. Between creation and
completion the wallet holds a pending deposit operation that is visible but
not spendable. With `holdDeposits` off (and the amount under
`holdDepositsAbove`, when set) a paid deposit goes straight to `completed`.

### Withdrawal lifecycle

```
awaiting_approval ──approve──▶ processing ──(bank transfer done)──▶ completed
   │  ▲                             └──(provider error)──▶ failed  (money released)
   │  └──(hold off: created directly as processing)
   ├──reject──▶ rejected   (money released)
   └──cancel──▶ cancelled  (player, only while awaiting_approval; money released)
```

The amount is **blocked in the wallet the moment the request is accepted**
(a pending withdrawal operation), so it cannot be bet or withdrawn twice.
`completed` finalises the wallet operation; `rejected`, `failed` and
`cancelled` cancel it and the blocked amount returns to the balance.

## Player endpoints

### `deposits-create` — POST `/api/v1/payments/deposits`

```jsonc
{ "amount": 1500.5,
  "payer": { "document": "30123456", "name": "Ana Perez", "email": "ana@example.com" } } // optional; document required for some countries
```

Returns the `Payment` (`pending`) with `checkoutUrl`. Send the player there;
after paying they come back to the configured return URL with
`?payment=<id>`. 422 `LIMIT_EXCEEDED` outside `[minDeposit, maxDeposit]`,
503 `NOT_CONFIGURED` when deposits are disabled.

### `withdrawals-create` — POST `/api/v1/payments/withdrawals`

```jsonc
{ "amount": 2000,
  "destination": { "type": "cbu", "value": "0170099220000067797370", "holderName": "Ana Perez" } }
```

`type` is `cbu` or `cvu`; `value` is 22 digits. Returns the `Payment`
(`awaiting_approval` or `processing`). 422 `INSUFFICIENT_FUNDS` when the
wallet has not enough withdrawable (payout) balance, `LIMIT_EXCEEDED` outside
`[minWithdrawal, maxWithdrawal]` or when the player already has
`maxOpenWithdrawals` open requests.

### `withdrawals-cancel` — POST `/api/v1/payments/withdrawals/{id}/cancel`

Only while `awaiting_approval`; otherwise 422 `INVALID_STATE`. Returns the
`Payment` (`cancelled`).

### `payments-list` — GET `/api/v1/payments`

Query: `kind` (`deposit` | `withdrawal`), `status` (comma list), `limit`
(default 20, max 100), `cursor` (from the previous page).

```jsonc
{ "data": [ Payment, ... ], "nextCursor": "eyJ..." | null }
```

### `payments-get` — GET `/api/v1/payments/{id}`

The player's own payment, 404 otherwise. A `pending` deposit older than a
minute is re-checked with the provider on read, so a missed webhook still
resolves when the player looks.

## Operator endpoints

All rows are scoped to the caller's chain subtree; a payment of a party
outside it is a 404.

### `admin-payments-list` — GET `/api/v1/payments/admin/payments`

Query: `kind`, `status` (comma list; `open` expands to every non-final
status), `partyId`, `from`, `to` (ISO dates, on `createdAt`), `limit`
(default 50, max 200), `cursor`. Response as `payments-list`, with the
operator fields.

### `admin-payments-get` — GET `/api/v1/payments/admin/payments/{id}`

```jsonc
{ "payment": Payment, "events": [ { "at": "...", "actor": "player" | "operator:<partyId>" | "provider" | "system", "type": "created", "data": {} } ] }
```

### `admin-payments-approve` — POST `.../{id}/approve` · `admin-payments-reject` — POST `.../{id}/reject`

Body `{ "note": "..." }` (optional on approve, required on reject, max 500).
Only `awaiting_approval` payments; otherwise 422 `INVALID_STATE`; a decision
that lost a race is 409 `CONFLICT`. Approving a deposit credits the wallet;
approving a withdrawal submits the bank transfer. Rejecting releases the
withdrawal's blocked amount or cancels the pending deposit operation (the
money the payer sent stays with the operator to refund outside the platform;
the event trail records it). Returns the `Payment`.

### `admin-settings-get` — GET · `admin-settings-update` — PUT `/api/v1/payments/admin/settings`

Settings are per tenant (the root of the caller's chain). Any operator may
read; only a **root** operator (empty chain) may update, others get 403.

```jsonc
{
  "depositsEnabled": true,
  "withdrawalsEnabled": true,
  "holdDeposits": false,            // every paid deposit waits for approval
  "holdDepositsAbove": 100000,      // or only from this amount; null = never
  "holdWithdrawals": true,          // every withdrawal waits for approval
  "holdWithdrawalsAbove": null,
  "minDeposit": 1000, "maxDeposit": 2000000,
  "minWithdrawal": 1000, "maxWithdrawal": 1000000,
  "maxOpenWithdrawals": 1,
  "currency": "ARS",                // read-only, from the deployment
  "updatedAt": "...", "updatedBy": "<partyId>" | null
}
```

PUT accepts any subset of the writable fields and returns the full object.

### `admin-reconcile` — POST `/api/v1/payments/admin/reconcile`

Re-checks with the provider every open payment of the caller's subtree that
has not changed for 10 minutes. `{ "checked": 12, "updated": 3 }`.

## Webhook — POST `/api/v1/payments/webhook`

Called by the provider, not by the front-ends. Raw body + the provider's
signature header; unsigned or badly signed calls are 401. Idempotent: a
delivery already processed answers 200 without side effects.
