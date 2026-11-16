/**
 * The skeleton every JWT-authenticated function shares, in both runtimes.
 *
 *   1. Identity   — Bearer JWT verified locally. 401 on failure.
 *   2. Audience   — player or operator, from the token. 403 on mismatch.
 *   3. Body       — the handler. A thrown PaymentsError becomes its status;
 *                   anything else is a 500 with a generic message.
 *
 * A handler never rejects: the envelope carries `statusCode`, and the HTTP
 * runtime lifts it into the response status. The provider webhook has its own
 * wrapper (`lambdas/webhook`): no JWT, HMAC instead.
 */

import { contextFromEvent, requireAudience, type Audience, type PaymentsEvent, type SecurityContext } from './auth';
import { PaymentsError, AuthError } from './errors';
import { log } from './logger';
import { GENERIC_MESSAGE } from './redact';
import { fail, ok, type Envelope } from './response';

export type { PaymentsEvent, SecurityContext };

export type Run<T> = (ctx: SecurityContext, event: PaymentsEvent) => Promise<T>;

export function paymentsHandler<T>(audience: Audience | 'any', run: Run<T>): (event: PaymentsEvent) => Promise<Envelope<T>> {
  return async (event: PaymentsEvent = {}) => {
    let ctx: SecurityContext;
    try {
      ctx = await contextFromEvent(event);
    } catch (err) {
      const wrapped = err instanceof PaymentsError ? err : new AuthError('authentication failed');
      log.warn('auth failed', { err: String(err) });
      return fail(wrapped);
    }

    try {
      requireAudience(ctx, audience);
    } catch (err) {
      log.warn('audience check failed', { caller: ctx.partyId, audience: ctx.audience, wanted: audience });
      return fail(err as PaymentsError);
    }

    try {
      return ok(await run(ctx, event));
    } catch (err) {
      if (err instanceof PaymentsError) {
        const level = err.httpErrorStatus >= 500 ? 'error' : 'warn';
        log[level]('request failed', { type: err.name, err: err.message, caller: ctx.partyId });
        return fail(err);
      }
      log.error('unhandled failure', { err: String(err), stack: (err as Error)?.stack });
      return fail(new PaymentsError(GENERIC_MESSAGE));
    }
  };
}
