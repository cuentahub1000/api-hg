/**
 * Provider webhook intake. Verifies the HMAC over the raw body, records the
 * delivery in `webhook_inbox` (the dedupe key is the body hash, so a retry of
 * the same delivery is answered 200 without side effects) and dispatches:
 *
 *   topic CHECKOUT             -> applyCheckout(id, status)
 *   topic TRANSACTION_REQUEST  -> applyPayout(id, status)       (withdrawals)
 *   anything else              -> recorded, ignored
 */

import { createHash } from 'node:crypto';
import { db } from '../_common/db';
import { getConfig } from '../_common/config';
import { AuthError, NotConfiguredError, ValidationError } from '../_common/errors';
import { log } from '../_common/logger';
import { applyCheckout, applyPayout } from './payments';
import { verifySignature } from './provider';

export interface WebhookResult { accepted: boolean; duplicate: boolean; handled: string }

export async function receive(rawBody: string, signatureHeader: string | undefined): Promise<WebhookResult> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const ok = verifySignature(rawBody, signatureHeader, cfg.provider.webhookSecret);
  const dedupe = createHash('sha256').update(rawBody).digest('hex');

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('Validation failed', 'body is not a JSON object');
  }
  const topic = str(body.topic);
  const eventType = str(body.eventType);
  const ref = str(body.id);

  const inserted = await db.one<{ id: string }>(
    `INSERT INTO webhook_inbox (topic, event_type, provider_ref, dedupe_key, body, signature_ok)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [topic || null, eventType || null, ref || null, dedupe, rawBody, ok],
  );
  if (!ok) {
    log.warn('webhook signature rejected', { topic, eventType, ref, signed: Boolean(signatureHeader) });
    throw new AuthError('invalid webhook signature');
  }
  if (!inserted) return { accepted: true, duplicate: true, handled: 'duplicate' };

  let handled = 'ignored';
  try {
    if (topic === 'CHECKOUT' && ref) {
      const status = str(body.status) || eventType.replace(/^checkout\./, '');
      await applyCheckout(ref, status, 'provider', { eventType, transactionId: body.transactionId ?? null });
      handled = `checkout:${status}`;
    } else if (topic === 'TRANSACTION_REQUEST' && ref) {
      const status = str(body.status);
      await applyPayout(ref, status, 'provider', { errorCode: str(body.errorCode) || null });
      handled = `payout:${status}`;
    }
    await db.execute('UPDATE webhook_inbox SET processed_at = now(), result = $2 WHERE id = $1', [inserted.id, handled]);
  } catch (err) {
    await db.execute('UPDATE webhook_inbox SET result = $2 WHERE id = $1', [inserted.id, `error: ${String(err).slice(0, 200)}`]);
    throw err;
  }
  return { accepted: true, duplicate: false, handled };
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
