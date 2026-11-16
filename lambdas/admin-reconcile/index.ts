/** `POST /api/v1/payments/admin/reconcile` — re-check every open payment of the subtree that has not moved for 10 minutes. */
import { paymentsHandler } from '../_common/handler';
import { reconcile } from '../_domain/payments';

export const handler = paymentsHandler('operator', async (ctx) => reconcile(ctx));
