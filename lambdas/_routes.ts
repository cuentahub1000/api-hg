/**
 * The source of truth for which endpoints exist.
 *
 * Each entry is one Lambda function (`${env}-hg-<slug>`) AND one HTTP
 * route of the Kubernetes service. `audience` is enforced by the handler
 * wrapper (`webhook` = provider callback, HMAC-verified, no JWT);
 * `resource`/`method` are the `(api-hg, resource, method)` tuple to
 * seed as Feature rows when the security-DB gate is adopted.
 *
 * Adding an endpoint means: an entry here, `lambdas/<slug>/index.ts`
 * exporting `handler`, a `tests/events/<slug>.json`, a line in `server/index.ts`
 * and a `deploy:` script in `cdk/package.json`.
 */

export type Audience = 'player' | 'operator' | 'webhook' | 'any';

export interface RouteSpec {
  slug: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** HTTP path, `{param}` placeholders become `event.path[param]`. */
  resource: string;
  audience: Audience;
  timeoutSec?: number;
  /** Lambda only: expose a public Function URL (the provider calls it). */
  publicUrl?: boolean;
}

export const API_NAME = 'api-hg';

export const ROUTES: readonly RouteSpec[] = [
  // --- player ----------------------------------------------------------
  { slug: 'deposits-create',    method: 'POST', resource: '/api/v1/payments/deposits',                    audience: 'player', timeoutSec: 30 },
  { slug: 'withdrawals-create', method: 'POST', resource: '/api/v1/payments/withdrawals',                 audience: 'player', timeoutSec: 30 },
  { slug: 'withdrawals-cancel', method: 'POST', resource: '/api/v1/payments/withdrawals/{id}/cancel',     audience: 'player', timeoutSec: 30 },
  { slug: 'payments-list',      method: 'GET',  resource: '/api/v1/payments',                             audience: 'player' },
  { slug: 'payments-get',       method: 'GET',  resource: '/api/v1/payments/{id}',                        audience: 'player', timeoutSec: 20 },

  // --- operator (back-office) -----------------------------------------
  { slug: 'admin-payments-list',    method: 'GET',  resource: '/api/v1/payments/admin/payments',              audience: 'operator' },
  { slug: 'admin-payments-get',     method: 'GET',  resource: '/api/v1/payments/admin/payments/{id}',         audience: 'operator' },
  { slug: 'admin-payments-approve', method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/approve', audience: 'operator', timeoutSec: 30 },
  { slug: 'admin-payments-reject',  method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/reject',  audience: 'operator', timeoutSec: 30 },
  { slug: 'admin-settings-get',     method: 'GET',  resource: '/api/v1/payments/admin/settings',              audience: 'operator' },
  { slug: 'admin-settings-update',  method: 'PUT',  resource: '/api/v1/payments/admin/settings',              audience: 'operator' },
  { slug: 'admin-reconcile',        method: 'POST', resource: '/api/v1/payments/admin/reconcile',             audience: 'operator', timeoutSec: 60 },

  // --- provider callback -------------------------------------------------
  { slug: 'webhook', method: 'POST', resource: '/api/v1/payments/webhook', audience: 'webhook', timeoutSec: 30, publicUrl: true },
];

export function routeFor(slug: string): RouteSpec {
  const r = ROUTES.find((x) => x.slug === slug);
  if (!r) throw new Error(`unknown route slug ${slug}`);
  return r;
}
