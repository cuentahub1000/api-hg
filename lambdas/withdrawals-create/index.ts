/**
 * `POST /api/v1/payments/withdrawals` — request a withdrawal to a bank account.
 * Body `{ amount, destination: { type: cbu|cvu, value, holderName? } }`. The
 * amount is blocked in the wallet at once; the request waits for approval or
 * goes straight to the bank transfer, per the tenant's settings.
 */
import { paymentsHandler } from '../_common/handler';
import { bodyObject } from '../_common/validate';
import { amount, destination } from '../_common/input';
import { createWithdrawal } from '../_domain/payments';

export const handler = paymentsHandler('player', async (ctx, event) => {
  const body = bodyObject(event.body);
  return createWithdrawal(ctx, { amount: amount(body), destination: destination(body) });
});
