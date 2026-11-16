/** `POST /api/v1/payments/admin/payments/{id}/cancel` — cancel a deposit nobody paid yet (checkout cancelled, pending wallet deposit dropped). Body `{ note }`. */
import { paymentsHandler } from '../_common/handler';
import { bodyObject, messageText } from '../_common/validate';
import { paymentId } from '../_common/input';
import { cancelDeposit } from '../_domain/payments';

export const handler = paymentsHandler('operator', async (ctx, event) => {
  const body = bodyObject(event.body);
  return cancelDeposit(ctx, paymentId(event.path), messageText(body, 'note', 500));
});
