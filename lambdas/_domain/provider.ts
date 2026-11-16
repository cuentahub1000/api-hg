/**
 * The payment provider (hg.cash) behind deposits and withdrawals. Internal
 * names only: nothing from this module is ever shown to a player.
 *
 *   createCheckout / getCheckout / cancelCheckout   hosted checkout = deposit
 *   createPayout / getPayout                         transaction request = withdrawal
 *   verifySignature                                  webhook HMAC-SHA256
 *
 * Provider amounts: checkouts take a decimal *string*, transaction requests a
 * JSON number. Statuses are mapped to ours in `payments.ts`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig, type ProviderConfig } from '../_common/config';
import { NotConfiguredError } from '../_common/errors';
import { upstream } from '../_common/http';
import type { Destination, Payer } from './types';
import { sandboxCancelCheckout, sandboxCreateCheckout, sandboxCreatePayout, sandboxGetCheckout, sandboxGetPayout } from './sandbox';

export type CheckoutStatus = 'pending' | 'awaiting_manual_review' | 'completed' | 'rejected' | 'cancelled' | 'expired';
export type PayoutStatus = 'PENDING' | 'AWAITING_REVIEW' | 'PROCESSING' | 'DONE' | 'ERROR' | 'CANCELLED';

export interface Checkout {
  id: string;
  status: CheckoutStatus | string;
  checkoutUrl: string | null;
  expiresAt: string | null;
  amount: number | null;
  transactionId: string | null;
}

export interface Payout {
  id: string;
  status: PayoutStatus | string;
  errorCode: string | null;
  errorMessage: string | null;
  amount: number | null;
}

async function cfg(): Promise<ProviderConfig> {
  const p = (await getConfig()).provider;
  if (!p) throw new NotConfiguredError('payments');
  return p;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, allow?: number[]): Promise<{ status: number; data: T }> {
  const p = await cfg();
  const { upstreamTimeoutMs } = await getConfig();
  return upstream<T>('payment provider', {
    method, url: `${p.apiUrl}${path}`, body, timeoutMs: upstreamTimeoutMs, allow,
    headers: { authorization: `Bearer ${p.apiToken}` },
  });
}

export interface CreateCheckoutInput {
  paymentId: string;
  amount: number;
  payer?: Payer;
  locale?: string;
  expiresInSeconds?: number;
}

export async function createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
  const p = await cfg();
  const { returnUrl, cancelUrl } = await getConfig();
  const q = `payment=${encodeURIComponent(input.paymentId)}`;
  if (p.mode === 'mock') {
    return sandboxCreateCheckout({ amount: input.amount, successUrl: `${returnUrl}?${q}`, cancelUrl: `${cancelUrl}?${q}&cancelled=1`, country: p.country, payerDocument: input.payer?.document });
  }
  const body: Record<string, unknown> = {
    country: p.country,
    amount: input.amount.toFixed(2),
    successUrl: `${returnUrl}?${q}`,
    cancelUrl: `${cancelUrl}?${q}&cancelled=1`,
    idempotencyKey: input.paymentId,
    metadata: { paymentId: input.paymentId },
    expiresInSeconds: input.expiresInSeconds ?? 86400,
    locale: input.locale === 'en' ? 'en' : 'es',
  };
  if (p.accountId) body.accountId = p.accountId;
  if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
  if (input.payer && (input.payer.document || input.payer.name || input.payer.email)) {
    body.payer = { document: input.payer.document, name: input.payer.name, email: input.payer.email };
  }
  const { data } = await call<Record<string, unknown>>('POST', '/checkouts', body);
  return toCheckout(data);
}

export async function getCheckout(id: string): Promise<Checkout | null> {
  if ((await cfg()).mode === 'mock') return sandboxGetCheckout(id);
  const { status, data } = await call<Record<string, unknown>>('GET', `/checkouts/${encodeURIComponent(id)}`, undefined, [404]);
  return status === 404 ? null : toCheckout(data);
}

export async function cancelCheckout(id: string): Promise<void> {
  if ((await cfg()).mode === 'mock') { sandboxCancelCheckout(id); return; }
  await call('POST', `/checkouts/${encodeURIComponent(id)}/cancel`, undefined, [404, 409, 422]);
}

export interface CreatePayoutInput {
  paymentId: string;
  amount: number;
  destination: Destination;
  concept?: string;
}

export async function createPayout(input: CreatePayoutInput): Promise<Payout> {
  const p = await cfg();
  if (p.mode === 'mock') return sandboxCreatePayout({ amount: input.amount, destination: `${input.destination.type}:${input.destination.value}` });
  const body: Record<string, unknown> = {
    accountId: p.accountId,
    amount: Number(input.amount.toFixed(2)),
    externalID: input.paymentId,
    concept: input.concept ?? 'Withdrawal',
    data: { paymentId: input.paymentId },
  };
  body[input.destination.type === 'cvu' ? 'toCVU' : 'toCBU'] = input.destination.value;
  if (input.destination.holderName) body.toName = input.destination.holderName;
  if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
  const { data } = await call<Record<string, unknown>>('POST', '/transactions', body);
  return toPayout(data);
}

export async function getPayout(id: string): Promise<Payout | null> {
  if ((await cfg()).mode === 'mock') return sandboxGetPayout(id);
  const { status, data } = await call<Record<string, unknown>>('GET', `/transaction/${encodeURIComponent(id)}/status`, undefined, [404]);
  return status === 404 ? null : toPayout(data);
}

/** `X-HG-Webhook-Signature: sha256=<hex>` over the raw body bytes. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

function toCheckout(d: Record<string, unknown>): Checkout {
  return {
    id: String(d.id ?? ''),
    status: String(d.status ?? 'pending'),
    checkoutUrl: (d.checkoutUrl as string | undefined) ?? null,
    expiresAt: (d.expiresAt as string | undefined) ?? null,
    amount: d.amount === undefined ? null : Number(d.amount),
    transactionId: (d.transactionId as string | undefined) ?? null,
  };
}

function toPayout(d: Record<string, unknown>): Payout {
  return {
    id: String(d.id ?? ''),
    status: String(d.status ?? 'PENDING').toUpperCase(),
    errorCode: (d.errorCode as string | undefined) ?? null,
    errorMessage: (d.errorMessage as string | undefined) ?? null,
    amount: d.amount === undefined ? null : Number(d.amount),
  };
}
