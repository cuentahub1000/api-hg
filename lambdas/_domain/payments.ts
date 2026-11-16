/**
 * The payment lifecycle. Every state change goes through here, writes the
 * row and an event in one transaction, and talks to the wallet / provider
 * through their clients only.
 *
 * Deposit:    pending -> (paid) -> awaiting_approval -> completed | rejected
 *                     -> under_review | expired | cancelled | failed
 *             wallet: CREDIT/deposit PENDING at creation; COMPLETE credits; CANCEL drops it.
 * Withdrawal: awaiting_approval | processing -> completed | rejected | failed | cancelled
 *             wallet: DEBIT/withdrawal PENDING blocks at creation; COMPLETE finalises;
 *             CANCEL (reject/fail/cancel) releases the blocked amount.
 *
 * Decisions take an optimistic lock on `version`, so two operators clicking
 * at once produce one decision and one 409.
 */

import { randomUUID } from 'node:crypto';
import { db, type Queryable } from '../_common/db';
import { getConfig } from '../_common/config';
import { ConflictError, InvalidStateError, LimitError, NotConfiguredError, NotFoundError, UpstreamError } from '../_common/errors';
import { log } from '../_common/logger';
import { rootOf } from '../_common/chain';
import type { SecurityContext } from '../_common/auth';
import * as provider from './provider';
import * as wallet from './wallet';
import { getSettings, needsHold } from './settings';
import {
  adminView, isFinal, moneyParam, playerView,
  type Destination, type Payer, type PaymentAdminView, type PaymentEventRow, type PaymentKind, type PaymentRow, type PaymentStatus, type PaymentView,
  OPEN_STATUSES,
} from './types';

// ---- reads -----------------------------------------------------------------

export interface ListFilter {
  kind?: PaymentKind;
  statuses?: PaymentStatus[];
  partyId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface Page<T> { data: T[]; nextCursor: string | null }

interface Cursor { at: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at))) return c;
  } catch { /* fall through */ }
  throw new InvalidStateError('invalid cursor');
}

/** Rows of the caller's own party (player) or of the caller's subtree (operator). */
async function listRows(scope: { partyId?: string; fullChain?: string }, f: ListFilter): Promise<Page<PaymentRow>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (scope.partyId) where.push(`party_id = ${p(scope.partyId)}`);
  if (scope.fullChain) where.push(`(chain = ${p(scope.fullChain)} OR chain LIKE ${p(`${scope.fullChain}-%`)})`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.statuses?.length) where.push(`status = ANY(${p(f.statuses)})`);
  if (f.partyId) where.push(`party_id = ${p(f.partyId)}`);
  if (f.from) where.push(`created_at >= ${p(f.from)}`);
  if (f.to) where.push(`created_at <= ${p(f.to)}`);
  const cur = decodeCursor(f.cursor);
  if (cur) where.push(`(created_at, id) < (${p(cur.at)}, ${p(cur.id)})`);
  const rows = await db.query<PaymentRow>(
    `SELECT * FROM payment ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${p(f.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return { data: page, nextCursor: rows.length > f.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null };
}

export async function listForPlayer(ctx: SecurityContext, f: ListFilter): Promise<Page<PaymentView>> {
  const page = await listRows({ partyId: ctx.partyId }, f);
  return { data: page.data.map(playerView), nextCursor: page.nextCursor };
}

export async function listForOperator(ctx: SecurityContext, f: ListFilter): Promise<Page<PaymentAdminView>> {
  const page = await listRows({ fullChain: ctx.fullChain }, f);
  return { data: page.data.map(adminView), nextCursor: page.nextCursor };
}

async function rowFor(id: string, scope: { partyId?: string; fullChain?: string }, q: Queryable = db, lock = false): Promise<PaymentRow> {
  const params: unknown[] = [id];
  let where = 'id = $1';
  if (scope.partyId) { params.push(scope.partyId); where += ` AND party_id = $${params.length}`; }
  if (scope.fullChain) { params.push(scope.fullChain, `${scope.fullChain}-%`); where += ` AND (chain = $${params.length - 1} OR chain LIKE $${params.length})`; }
  const row = await q.one<PaymentRow>(`SELECT * FROM payment WHERE ${where}${lock ? ' FOR UPDATE' : ''}`, params);
  if (!row) throw new NotFoundError('Payment not found');
  return row;
}

export async function getForPlayer(ctx: SecurityContext, id: string): Promise<PaymentView> {
  let row = await rowFor(id, { partyId: ctx.partyId });
  row = await recheckIfStale(row);
  return playerView(row);
}

export async function getForOperator(ctx: SecurityContext, id: string): Promise<{ payment: PaymentAdminView; events: Array<{ at: string; actor: string; type: string; data: unknown }> }> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  const events = await db.query<PaymentEventRow>('SELECT * FROM payment_event WHERE payment_id = $1 ORDER BY id', [row.id]);
  return { payment: adminView(row), events: events.map((e) => ({ at: e.at, actor: e.actor, type: e.type, data: e.data })) };
}

// ---- writes ------------------------------------------------------------------

async function addEvent(q: Queryable, paymentId: string, actor: string, type: string, data?: unknown): Promise<void> {
  await q.execute('INSERT INTO payment_event (payment_id, actor, type, data) VALUES ($1, $2, $3, $4)', [paymentId, actor, type, data === undefined ? null : JSON.stringify(data)]);
}

interface Patch {
  status?: PaymentStatus;
  hold?: boolean;
  wallet_operation_id?: string | null;
  wallet_status?: string | null;
  provider_ref?: string | null;
  provider_status?: string | null;
  checkout_url?: string | null;
  expires_at?: string | null;
  fee?: number | null;
  note?: string | null;
  decided_by?: string | null;
  error_code?: string | null;
  completed?: boolean;
}

/** UPDATE the row; with `expectVersion` it is an optimistic lock (0 rows = 409). */
async function patch(q: Queryable, id: string, p: Patch, expectVersion?: number): Promise<PaymentRow> {
  const sets: string[] = ['updated_at = now()', 'version = version + 1'];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'completed') { if (v) sets.push('completed_at = now()'); continue; }
    if (k === 'fee') { add('fee', v === null || v === undefined ? null : moneyParam(v as number)); continue; }
    if (k === 'decided_by') { add('decided_by', v); sets.push('decided_at = now()'); continue; }
    add(k, v);
  }
  let where = 'id = $1';
  if (expectVersion !== undefined) { params.push(expectVersion); where += ` AND version = $${params.length}`; }
  const row = await q.one<PaymentRow>(`UPDATE payment SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params);
  if (!row) throw new ConflictError('The payment was changed by someone else');
  return row;
}

async function assertOpen(row: PaymentRow, allowed: PaymentStatus[]): Promise<void> {
  if (!allowed.includes(row.status)) throw new InvalidStateError(`A ${row.kind} in status '${row.status}' cannot take this action`);
}

export interface CreateDepositInput { amount: number; payer?: Payer; locale?: string }

export async function createDeposit(ctx: SecurityContext, input: CreateDepositInput): Promise<PaymentView> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const tenant = rootOf(ctx.fullChain);
  const s = await getSettings(tenant);
  if (!s.depositsEnabled) throw new NotConfiguredError('deposits');
  if (input.amount < s.minDeposit || input.amount > s.maxDeposit) throw new LimitError(`Amount must be between ${s.minDeposit} and ${s.maxDeposit}`);

  const account = await wallet.findAccount(ctx.partyId);
  const id = randomUUID();
  // 1. our row, so the provider and wallet references always have a home
  await db.execute(
    `INSERT INTO payment (id, kind, status, tenant, party_id, username, chain, account_id, currency, amount, payer)
     VALUES ($1, 'deposit', 'pending', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, tenant, ctx.partyId, ctx.username || null, ctx.chain, account.id, account.currencyId ?? cfg.currency, moneyParam(input.amount), input.payer ? JSON.stringify(input.payer) : null],
  );
  await addEvent(db, id, 'player', 'created', { amount: input.amount });

  // 2. the wallet's pending deposit (visible, not spendable)
  let row: PaymentRow;
  try {
    const op = await wallet.createOperation({ kind: 'deposit', accountId: account.id, amount: input.amount, externalReference: `pay-${id}` });
    row = await patch(db, id, { wallet_operation_id: op.identifier, wallet_status: op.status });
    await addEvent(db, id, 'system', 'wallet_pending', { operation: op.identifier });
  } catch (err) {
    await patch(db, id, { status: 'failed', error_code: 'WALLET' });
    await addEvent(db, id, 'system', 'failed', { step: 'wallet' });
    throw err;
  }

  // 3. the hosted checkout
  try {
    const co = await provider.createCheckout({ paymentId: id, amount: input.amount, payer: input.payer, locale: input.locale });
    row = await patch(db, id, { provider_ref: co.id, provider_status: co.status, checkout_url: co.checkoutUrl, expires_at: co.expiresAt });
    await addEvent(db, id, 'system', 'checkout_opened', { ref: co.id });
  } catch (err) {
    await cancelWalletQuietly(row, 'provider');
    await patch(db, id, { status: 'failed', error_code: 'PROVIDER' });
    await addEvent(db, id, 'system', 'failed', { step: 'provider' });
    throw err;
  }
  return playerView(row);
}

export interface CreateWithdrawalInput { amount: number; destination: Destination }

export async function createWithdrawal(ctx: SecurityContext, input: CreateWithdrawalInput): Promise<PaymentView> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const tenant = rootOf(ctx.fullChain);
  const s = await getSettings(tenant);
  if (!s.withdrawalsEnabled) throw new NotConfiguredError('withdrawals');
  if (input.amount < s.minWithdrawal || input.amount > s.maxWithdrawal) throw new LimitError(`Amount must be between ${s.minWithdrawal} and ${s.maxWithdrawal}`);
  const open = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment WHERE party_id = $1 AND kind = 'withdrawal' AND status = ANY($2)`,
    [ctx.partyId, OPEN_STATUSES],
  );
  if (Number(open?.n ?? 0) >= s.maxOpenWithdrawals) throw new LimitError('You already have an open withdrawal request');

  const account = await wallet.findAccount(ctx.partyId);
  const hold = needsHold('withdrawal', input.amount, s);
  const id = randomUUID();
  await db.execute(
    `INSERT INTO payment (id, kind, status, tenant, party_id, username, chain, account_id, currency, amount, hold, destination)
     VALUES ($1, 'withdrawal', 'awaiting_approval', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, tenant, ctx.partyId, ctx.username || null, ctx.chain, account.id, account.currencyId ?? cfg.currency, moneyParam(input.amount), hold, JSON.stringify(input.destination)],
  );
  await addEvent(db, id, 'player', 'created', { amount: input.amount, destination: { type: input.destination.type, last4: input.destination.value.slice(-4) } });

  // Block the money now. The wallet refuses when the payout bucket is short.
  let row: PaymentRow;
  try {
    const op = await wallet.createOperation({ kind: 'withdrawal', accountId: account.id, amount: input.amount, externalReference: `pay-${id}` });
    row = await patch(db, id, { wallet_operation_id: op.identifier, wallet_status: op.status });
    await addEvent(db, id, 'system', 'wallet_blocked', { operation: op.identifier });
  } catch (err) {
    await patch(db, id, { status: 'failed', error_code: 'WALLET' });
    await addEvent(db, id, 'system', 'failed', { step: 'wallet' });
    throw err;
  }

  if (hold) {
    await addEvent(db, id, 'system', 'held');
    return playerView(row);
  }
  return playerView(await submitPayout(row, 'system'));
}

/** Player cancels a withdrawal that has not been approved yet. */
export async function cancelWithdrawal(ctx: SecurityContext, id: string): Promise<PaymentView> {
  const row = await rowFor(id, { partyId: ctx.partyId });
  if (row.kind !== 'withdrawal') throw new InvalidStateError('Only withdrawals can be cancelled');
  await assertOpen(row, ['awaiting_approval']);
  return playerView(await release(row, 'cancelled', 'player', null));
}

export async function approve(ctx: SecurityContext, id: string, note: string | undefined): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  await assertOpen(row, ['awaiting_approval']);
  const actor = `operator:${ctx.partyId}`;
  if (row.kind === 'deposit') {
    const updated = await completeDeposit(row, actor, note ?? null);
    return adminView(updated);
  }
  // withdrawal: mark the decision first (lock), then submit the bank transfer
  const decided = await patch(db, row.id, { note: note ?? null, decided_by: ctx.partyId }, row.version);
  await addEvent(db, id, actor, 'approved', note ? { note } : undefined);
  return adminView(await submitPayout(decided, actor));
}

export async function reject(ctx: SecurityContext, id: string, note: string): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  await assertOpen(row, ['awaiting_approval']);
  return adminView(await release(row, 'rejected', `operator:${ctx.partyId}`, note, ctx.partyId));
}

// ---- transitions shared by handlers, webhook and reconcile -----------------

/** Deposit -> completed: credit the wallet, then close the row. */
async function completeDeposit(row: PaymentRow, actor: string, note: string | null): Promise<PaymentRow> {
  if (!row.wallet_operation_id) throw new UpstreamError('wallet', 500);
  const op = await wallet.transition(row.wallet_operation_id, 'COMPLETE');
  const updated = await patch(db, row.id, {
    status: 'completed', wallet_status: op.status, completed: true, note,
    ...(actor.startsWith('operator:') ? { decided_by: actor.slice('operator:'.length) } : {}),
  }, row.version);
  await addEvent(db, row.id, actor, 'completed', { operation: op.identifier });
  return updated;
}

/**
 * Withdrawal or deposit leaves the pipeline without money moving: cancel the
 * wallet operation (releases a blocked withdrawal / drops a pending deposit).
 */
async function release(row: PaymentRow, status: 'rejected' | 'cancelled' | 'failed' | 'expired', actor: string, note: string | null, decidedBy?: string, errorCode?: string): Promise<PaymentRow> {
  let walletStatus = row.wallet_status;
  if (row.wallet_operation_id) {
    const op = await wallet.transition(row.wallet_operation_id, 'CANCEL');
    walletStatus = op.status;
  }
  if (row.kind === 'deposit' && row.provider_ref && row.status === 'pending' && status === 'cancelled') {
    await provider.cancelCheckout(row.provider_ref).catch((err) => log.warn('checkout cancel failed', { id: row.id, err: String(err) }));
  }
  const updated = await patch(db, row.id, {
    status, wallet_status: walletStatus, note: note ?? row.note, error_code: errorCode ?? null,
    ...(decidedBy ? { decided_by: decidedBy } : {}),
  }, row.version);
  await addEvent(db, row.id, actor, status, note ? { note } : undefined);
  return updated;
}

/** Approved (or never held) withdrawal: ask the provider for the bank transfer. */
async function submitPayout(row: PaymentRow, actor: string): Promise<PaymentRow> {
  if (!row.destination) throw new InvalidStateError('withdrawal has no destination');
  try {
    const po = await provider.createPayout({ paymentId: row.id, amount: Number(row.amount), destination: row.destination });
    const updated = await patch(db, row.id, { status: 'processing', provider_ref: po.id, provider_status: po.status });
    await addEvent(db, row.id, actor, 'submitted', { ref: po.id });
    return updated;
  } catch (err) {
    // The transfer never left: give the money back and surface the failure.
    const failed = await release(row, 'failed', 'system', null, undefined, 'PROVIDER');
    log.error('payout submit failed', { id: row.id, err: String(err) });
    return failed;
  }
}

/** Apply a provider checkout status to a deposit (webhook or re-check). */
export async function applyCheckout(ref: string, status: string, actor: 'provider' | 'system', extra?: Record<string, unknown>): Promise<PaymentRow | null> {
  const row = await db.one<PaymentRow>(`SELECT * FROM payment WHERE provider_ref = $1 AND kind = 'deposit'`, [ref]);
  if (!row) { log.warn('checkout for unknown payment', { ref, status }); return null; }
  if (isFinal(row.status)) return row;
  const s = status.toLowerCase();
  if (s === row.provider_status && !(s === 'completed' && row.status === 'pending')) return row;
  await patch(db, row.id, { provider_status: s });
  switch (s) {
    case 'completed': {
      if (row.status === 'awaiting_approval') return row;
      const settings = await getSettings(row.tenant);
      if (needsHold('deposit', Number(row.amount), settings)) {
        const held = await patch(db, row.id, { status: 'awaiting_approval', hold: true });
        await addEvent(db, row.id, actor, 'paid', extra);
        await addEvent(db, row.id, 'system', 'held');
        return held;
      }
      await addEvent(db, row.id, actor, 'paid', extra);
      return completeDeposit(await rowFor(row.id, {}), 'system', null);
    }
    case 'awaiting_manual_review': {
      const r = await patch(db, row.id, { status: 'under_review' });
      await addEvent(db, row.id, actor, 'under_review');
      return r;
    }
    case 'rejected': return release(row, 'rejected', actor, null, undefined, 'PROVIDER_REJECTED');
    case 'expired': return release(row, 'expired', actor, null);
    case 'cancelled': return release(row, 'cancelled', actor, null);
    case 'pending': return row;
    default:
      log.warn('unknown checkout status', { ref, status });
      return row;
  }
}

/** Apply a provider payout status to a withdrawal (webhook or re-check). */
export async function applyPayout(ref: string, status: string, actor: 'provider' | 'system', extra?: { errorCode?: string | null; fee?: number | null }): Promise<PaymentRow | null> {
  const row = await db.one<PaymentRow>(`SELECT * FROM payment WHERE provider_ref = $1 AND kind = 'withdrawal'`, [ref]);
  if (!row) { log.warn('payout for unknown payment', { ref, status }); return null; }
  if (isFinal(row.status)) return row;
  const s = status.toUpperCase();
  if (s === row.provider_status) return row;
  await patch(db, row.id, { provider_status: s, ...(extra?.fee !== undefined ? { fee: extra.fee } : {}) });
  switch (s) {
    case 'DONE': {
      if (!row.wallet_operation_id) throw new UpstreamError('wallet', 500);
      const op = await wallet.transition(row.wallet_operation_id, 'COMPLETE');
      const r = await patch(db, row.id, { status: 'completed', wallet_status: op.status, completed: true });
      await addEvent(db, row.id, actor, 'completed', { operation: op.identifier });
      return r;
    }
    case 'ERROR': return release(row, 'failed', actor, null, undefined, extra?.errorCode ?? 'PROVIDER_ERROR');
    case 'CANCELLED': return release(row, 'cancelled', actor, null);
    default: return row; // PENDING, AWAITING_REVIEW, PROCESSING: still on its way
  }
}

// ---- reconciliation ------------------------------------------------------------

async function recheckIfStale(row: PaymentRow): Promise<PaymentRow> {
  if (row.kind !== 'deposit' || row.status !== 'pending' || !row.provider_ref) return row;
  const { recheckAfterMs } = await getConfig();
  if (Date.now() - Date.parse(row.updated_at) < recheckAfterMs) return row;
  try {
    return (await recheck(row)) ?? row;
  } catch (err) {
    log.warn('re-check failed', { id: row.id, err: String(err) });
    return row;
  }
}

/** Ask the provider for the current state of one open payment. */
export async function recheck(row: PaymentRow): Promise<PaymentRow | null> {
  if (!row.provider_ref || isFinal(row.status)) return row;
  if (row.kind === 'deposit') {
    const co = await provider.getCheckout(row.provider_ref);
    if (!co) return row;
    if (co.status.toLowerCase() === row.provider_status && row.status !== 'pending') { await patch(db, row.id, {}); return row; }
    return applyCheckout(row.provider_ref, co.status, 'system', { transactionId: co.transactionId, source: 'recheck' });
  }
  if (row.status !== 'processing') return row;
  const po = await provider.getPayout(row.provider_ref);
  if (!po) return row;
  if (po.status === row.provider_status) { await patch(db, row.id, {}); return row; }
  return applyPayout(row.provider_ref, po.status, 'system', { errorCode: po.errorCode });
}

export async function reconcile(ctx: SecurityContext, staleMs = 10 * 60_000): Promise<{ checked: number; updated: number }> {
  const rows = await db.query<PaymentRow>(
    `SELECT * FROM payment
      WHERE (chain = $1 OR chain LIKE $2) AND status = ANY($3) AND provider_ref IS NOT NULL
        AND updated_at < now() - ($4::text || ' milliseconds')::interval
      ORDER BY updated_at LIMIT 200`,
    [ctx.fullChain, `${ctx.fullChain}-%`, ['pending', 'under_review', 'processing'], String(staleMs)],
  );
  let updated = 0;
  for (const row of rows) {
    try {
      const after = await recheck(row);
      if (after && after.status !== row.status) updated++;
    } catch (err) {
      log.warn('reconcile item failed', { id: row.id, err: String(err) });
    }
  }
  return { checked: rows.length, updated };
}

async function cancelWalletQuietly(row: PaymentRow, reason: string): Promise<void> {
  if (!row.wallet_operation_id) return;
  try {
    await wallet.transition(row.wallet_operation_id, 'CANCEL');
  } catch (err) {
    log.error('wallet cancel failed after provider failure', { id: row.id, reason, err: String(err) });
  }
}
