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
`LIMIT_EXCEEDED` (422, generic: the player is never told which limit),
`REQUEST_IN_PROGRESS` (422, `detail` names the blocking withdrawal), `BLOCKED`
(403, an operator blocked this kind for the player; tell them to contact
support), `INSUFFICIENT_FUNDS` (422), `UPSTREAM_ERROR` (502),
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
| `admin-payments-cancel` | `/api/v1/payments/admin/payments/{id}/cancel` | POST | operator |
| `admin-reconcile` | `/api/v1/payments/admin/reconcile` | POST | operator |
| `admin-player-get` | `/api/v1/payments/admin/players/{partyId}` | GET | operator |
| `admin-player-limits-update` | `/api/v1/payments/admin/players/{partyId}/limits` | PUT | operator |
| `admin-player-block` | `/api/v1/payments/admin/players/{partyId}/blocks` | POST | operator |
| `admin-player-unblock` | `/api/v1/payments/admin/players/{partyId}/blocks/{blockId}/lift` | POST | operator |
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
`provider` (which integration handled it, e.g. `hg`), `walletOperationId`,
`walletStatus`, `providerRef`, `providerStatus`, `providerData` (the
provider's raw response, verbatim), `payer` (deposits: `{ name, email }` — the
national id is **not** stored), `documentHash` (keyed HMAC-SHA256 of the
national id the player gave, for comparing later entries without holding the
number), `client` (`{ ip, userAgent }` of the request, from the
`x-player-ip` / `x-player-user-agent` headers the front-end forwards),
`decidedBy`, `decidedAt`, `errorCode`.

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
`?payment=<id>`. 422 `LIMIT_EXCEEDED` outside the player's effective limits
(per request or rolling caps; generic message), 403 `BLOCKED` when an operator
blocked deposits for the player, 503 `NOT_CONFIGURED` when deposits are
disabled. `payer.document` is forwarded to the provider and kept only as
`documentHash`.

### `withdrawals-create` — POST `/api/v1/payments/withdrawals`

```jsonc
{ "amount": 2000,
  "destination": { "type": "cbu", "value": "0170099220000067797370", "holderName": "Ana Perez" } }
```

`type` is `cbu` or `cvu`; `value` is 22 digits; `document` (optional national
id) is hashed, never stored. Returns the `Payment` (`awaiting_approval` or
`processing`). 422 `INSUFFICIENT_FUNDS` when the wallet has not enough
withdrawable (payout) balance; 422 `LIMIT_EXCEEDED` when the amount is outside
the player's effective limits (per request or rolling day/week/month caps — the
message never says which); 422 `REQUEST_IN_PROGRESS` when the player already
has `maxOpenWithdrawals` open (`detail` = the blocking one); 403 `BLOCKED` when
an operator blocked withdrawals for the player.

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
status, `all` means no filter), `accountId` (the wallet account, the id to track payments by), `partyId`, `from`, `to` (ISO dates, on `createdAt`), `limit`
(default 50, max 200), `cursor`. Response as `payments-list`, with the
operator fields.

### `admin-payments-get` — GET `/api/v1/payments/admin/payments/{id}`

```jsonc
{ "payment": Payment, "events": [ { "at": "...", "actor": "player" | "operator:<partyId>" | "provider" | "system", "actorName": "Ana Perez" | null, "type": "created", "data": {} } ] }
```

`actorName` is the display name of the player or operator behind the event;
show it, not the id.

```jsonc
```

### `admin-payments-approve` — POST `.../{id}/approve` · `admin-payments-reject` — POST `.../{id}/reject`

Body `{ "note": "..." }` (optional on approve, required on reject, max 500).
Only `awaiting_approval` payments; otherwise 422 `INVALID_STATE`; a decision
that lost a race is 409 `CONFLICT`. Approving a deposit credits the wallet;
approving a withdrawal submits the bank transfer. Rejecting releases the
withdrawal's blocked amount or cancels the pending deposit operation (the
money the payer sent stays with the operator to refund outside the platform;
the event trail records it). Returns the `Payment`.

### `admin-payments-cancel` — POST `.../{id}/cancel`

Body `{ "note" }` (required). Only a deposit still `pending` (nobody paid):
the provider's checkout is cancelled and the pending wallet deposit dropped.
Returns the `Payment` (`cancelled`).

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
  "dailyDepositMax": null, "weeklyDepositMax": null, "monthlyDepositMax": null,       // rolling 24 h / 7 d / 30 d caps; null = none
  "dailyWithdrawalMax": null, "weeklyWithdrawalMax": null, "monthlyWithdrawalMax": null,
  "maxOpenWithdrawals": 1,
  "currency": "ARS",                // read-only, from the deployment
  "updatedAt": "...", "updatedBy": "<partyId>" | null
}
```

PUT accepts any subset of the writable fields and returns the full object.

### Per-player limits and blocks

`GET /api/v1/payments/admin/players/{partyId}` (`admin-player-get`):

```jsonc
{
  "partyId": "...",
  "limits": { "minDeposit": null, "maxDeposit": null, "minWithdrawal": null, "maxWithdrawal": 50000,   // the player's overrides; null = tenant value
              "dailyDepositMax": null, "weeklyDepositMax": null, "monthlyDepositMax": null,
              "dailyWithdrawalMax": 100000, "weeklyWithdrawalMax": null, "monthlyWithdrawalMax": null,
              "maxOpenWithdrawals": null, "note": "VIP review pending", "updatedAt": "...", "updatedBy": "<partyId>" },
  "effective": { "deposit": { "min": 1000, "max": 2000000, "daily": null, "weekly": null, "monthly": null, "maxOpenWithdrawals": 1 },
                 "withdrawal": { "min": 1000, "max": 50000, "daily": 100000, "weekly": null, "monthly": null, "maxOpenWithdrawals": 1 } },
  "usage": { "deposit": { "day": 2000, "week": 2000, "month": 2000 }, "withdrawal": { "day": 0, "week": 0, "month": 0 } },
  "blocks": [ { "id": 1, "kind": "withdrawal", "until": "2026-11-18T..." | null, "reason": "...", "createdBy": "...", "createdAt": "...", "liftedAt": null, "liftedBy": null, "active": true } ],
  "blocked": { "deposit": false, "withdrawal": true }
}
```

`PUT .../players/{partyId}/limits` (`admin-player-limits-update`): any subset
of the `limits` fields; `null` removes an override. Returns the overview.

`POST .../players/{partyId}/blocks` (`admin-player-block`): `{ "kind":
"deposit" | "withdrawal" | "all", "reason", "days"?: 2 | "until"?: ISO }`;
neither `days` nor `until` = permanent. Returns the overview.

`POST .../players/{partyId}/blocks/{blockId}/lift` (`admin-player-unblock`):
lifts one block early. Returns the overview.

Usage windows are rolling (last 24 h / 7 d / 30 d) over every payment of the
kind that is or may become money moved (`pending`, `under_review`,
`awaiting_approval`, `processing`, `completed`). A player outside the
operator's subtree is a 404; a player with no payment yet can only be managed
by a root operator.

### `admin-reconcile` — POST `/api/v1/payments/admin/reconcile`

Re-checks with the provider every open payment of the caller's subtree that
has not changed for 10 minutes. `{ "checked": 12, "updated": 3 }`.

## Webhook — POST `/api/v1/payments/webhook`

Called by the provider, not by the front-ends. Raw body + the provider's
signature header; unsigned or badly signed calls are 401. Idempotent: a
delivery already processed answers 200 without side effects.
