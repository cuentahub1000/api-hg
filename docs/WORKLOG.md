# Worklog — api-hg (payments)

Running log of what was built and why. Dates are 2026-11-16 unless noted.

## Decisions

* **Architecture copied from api-engagement / wallet-lambda**: route table,
  handler wrapper with JWT audiences, envelope + redaction, one Lambda per
  route, HTTP runtime for Kubernetes/local, CDK one-stack-per-function.
* **Own database**, Aurora Serverless v2 (`<env>-hg-postgres`), tables
  `payment`, `payment_event`, `webhook_inbox`, `payment_settings`. The wallet
  DB is never opened (user requirement); the wallet is used only through
  `parties-get`, `operations-create`, `operations-transition` with a service
  `x-api-key`.
* **Wallet mapping**: deposit = `CREDIT/deposit` (PENDING on create, COMPLETE
  to credit, CANCEL to drop); withdrawal = `DEBIT/withdrawal` (blocks on
  create, COMPLETE when the bank transfer is done, CANCEL to release). Both
  pairs exist in the wallet's state machines (`PENDING → COMPLETE | CANCEL`).
* **Holds** per tenant (`rootOf(chain)`): `holdDeposits` /
  `holdDepositsAbove`, `holdWithdrawals` (default on) / `holdWithdrawalsAbove`,
  plus min/max limits and `maxOpenWithdrawals`. Root operators edit them.
* **Provider (hg.cash)**: checkouts for deposits (`POST /checkouts`, hosted
  `checkoutUrl`, statuses pending / awaiting_manual_review / completed /
  rejected / cancelled / expired), transaction requests for withdrawals
  (`POST /transactions` with `toCBU`/`toCVU`, statuses PENDING /
  AWAITING_REVIEW / PROCESSING / DONE / ERROR / CANCELLED), webhook signed
  `X-HG-Webhook-Signature: sha256=<hmac>` over the raw body. Argentina (ARS)
  first; `PAYMENTS_COUNTRY` is a setting.
* **Webhook idempotency**: `webhook_inbox.dedupe_key` = sha256 of the raw
  body; a repeat answers 200 without side effects. Missed webhooks are covered
  by the on-read re-check (`payments-get`, pending deposits older than
  `PAYMENTS_RECHECK_AFTER_MS`) and `admin-reconcile`.
* **Naming**: the service is `api-hg` (repo name) in every internal
  identifier (functions `<env>-hg-*`, SSM `/<env>/api-hg-lambda`, secret
  `<env>/HgSecrets`, env `API_HG_URL`/`API_HG_MODE` in the front-ends). The
  feature flag in both front-ends is `PAYMENTS_ENABLED`. Nothing visible to a
  player names the provider or any infrastructure (user requirement).
* **Previews first** (user requirement): front-self and backoffice render the
  cashier with canned data under `API_HG_MODE=mock`; the local shim is this
  service's HTTP runtime (`npm run server`) reached with `API_HG_MODE=http`.
* **Nothing deployed.** No `cdk deploy`, no containers started by the
  assistant. Front-self changes are uncommitted because that checkout has no
  git history on this machine; backoffice committed on branch `payments`.

## Built

* `lambdas/_routes.ts` — 13 routes + audiences; `webhook` has `publicUrl`.
* `_common`: auth/handler/errors/response/redact/http/token/logger/validate
  (from api-engagement), `config.ts`, `db.ts`, `input.ts`.
* `_domain`: `types.ts`, `settings.ts`, `wallet.ts`, `provider.ts`,
  `payments.ts`, `webhook.ts`.
* Handlers for every route, `migrate` function, `server/` runtime,
  `sql/001_init.sql`, `scripts/migrate.ts`, `scripts/bootstrap-ssm.sh`,
  `deploy/Dockerfile`, `infra/docker-compose.yml`, `.env.example`.
* CDK: `config.ts`, `resource-group-stack.ts` (player/operator invoker
  policies), `database-stack.ts`, `function-stack.ts` (exec role, DB ingress,
  wallet invoker policy, webhook Function URL, migrate bundling of `sql/`),
  `bin/app.ts`. Synthesised with a fake account: resource group, webhook and
  migrate stacks render; not deployed.
* Tests: 20 unit tests (auth/handler, holds, signature, cursor, views, input
  readers, router) — `npm test` passes.
* Docs: `LAMBDA_API.md`, `README.md`, `CLAUDE.md`, `infra/README.md`.

## Front-ends

* front-self (branch `payments`, uncommitted): `src/lib/payments.ts`,
  `src/lib/api/payments/*`, `/api/payments/*` routes,
  `src/components/payments/*`, pages `/wallet/deposit`, `/wallet/withdraw`,
  `/wallet/deposit/return`, drawer blades, `PaymentsProvider` in the app
  layout, styles, es/pt strings, `docs/payments.md`, CLAUDE.md note.
* backoffice (branch `payments`, committed by the backoffice session):
  Payments menu + `/payments` list/detail (approve/reject), `/payments/settings`,
  reconcile button, mock mode, `docs/payments.md`.

## Open items / assumptions to confirm

* A wallet user + `x-api-key` with features for `parties-get`,
  `operations-create`, `operations-transition` must be provisioned per env
  (`WALLET_API_KEY`).
* hg.cash: one operative ARS account; register the webhook URL and signing
  secret in the dashboard. Payer document is optional in the forms; AR
  checkouts match transfers by DNI, so operators may want it mandatory
  (toggle later).
* `payments-get` re-checks the provider on read; a scheduled reconcile is not
  wired (operators have the button).
* Deposit `rejected` after payment: money stays with the operator's provider
  account; refund is manual and recorded in the event trail.
