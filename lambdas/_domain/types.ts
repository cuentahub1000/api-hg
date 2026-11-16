/**
 * Payment rows and the shapes callers see. Amounts are `numeric(18,2)` in
 * Postgres (strings on the wire from `pg`) and `number` here; two decimals
 * never lose precision below 2^53 / 100, which is far beyond any limit.
 */

export type PaymentKind = 'deposit' | 'withdrawal';

export type DepositStatus = 'pending' | 'under_review' | 'awaiting_approval' | 'completed' | 'rejected' | 'expired' | 'cancelled' | 'failed';
export type WithdrawalStatus = 'awaiting_approval' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled';
export type PaymentStatus = DepositStatus | WithdrawalStatus;

export const DEPOSIT_STATUSES: readonly DepositStatus[] = ['pending', 'under_review', 'awaiting_approval', 'completed', 'rejected', 'expired', 'cancelled', 'failed'];
export const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = ['awaiting_approval', 'processing', 'completed', 'rejected', 'failed', 'cancelled'];
export const ALL_STATUSES: readonly PaymentStatus[] = [...new Set<PaymentStatus>([...DEPOSIT_STATUSES, ...WITHDRAWAL_STATUSES])];
export const FINAL_STATUSES: readonly PaymentStatus[] = ['completed', 'rejected', 'expired', 'cancelled', 'failed'];
export const OPEN_STATUSES: readonly PaymentStatus[] = ALL_STATUSES.filter((s) => !FINAL_STATUSES.includes(s));

export function isFinal(status: PaymentStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export type DestinationType = 'cbu' | 'cvu';

export interface Destination {
  type: DestinationType;
  value: string;
  holderName?: string | null;
}

export interface Payer {
  document?: string;
  name?: string;
  email?: string;
}

/** A `payment` row as `pg` returns it. */
export interface PaymentRow {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  tenant: string;
  party_id: string;
  username: string | null;
  chain: string;
  account_id: string;
  currency: string;
  amount: string;
  fee: string | null;
  hold: boolean;
  wallet_operation_id: string | null;
  wallet_status: string | null;
  provider_ref: string | null;
  provider_status: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  destination: Destination | null;
  payer: Payer | null;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  version: number;
}

export interface PaymentEventRow {
  id: string;
  payment_id: string;
  at: string;
  actor: string;
  type: string;
  data: unknown;
}

/** What a player sees. */
export interface PaymentView {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount: number;
  currency: string;
  fee: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  hold: boolean;
  checkoutUrl: string | null;
  expiresAt: string | null;
  destination: Destination | null;
  note: string | null;
}

/** What an operator sees: the player view plus the internals. */
export interface PaymentAdminView extends PaymentView {
  partyId: string;
  username: string | null;
  chain: string;
  accountId: string;
  walletOperationId: string | null;
  walletStatus: string | null;
  providerRef: string | null;
  providerStatus: string | null;
  payer: Payer | null;
  decidedBy: string | null;
  decidedAt: string | null;
  errorCode: string | null;
}

export function money(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** `numeric` literal for a parameter: fixed two decimals, no float noise. */
export function moneyParam(n: number): string {
  return n.toFixed(2);
}

export function maskDestination(d: Destination | null): Destination | null {
  if (!d) return null;
  return { type: d.type, value: `•••• ${d.value.slice(-4)}`, holderName: d.holderName ?? null };
}

export function playerView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    amount: money(r.amount) ?? 0,
    currency: r.currency,
    fee: money(r.fee),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    hold: r.hold,
    checkoutUrl: r.kind === 'deposit' && r.status === 'pending' ? r.checkout_url : null,
    expiresAt: r.kind === 'deposit' ? r.expires_at : null,
    destination: maskDestination(r.destination),
    // Only a rejection reason is for the player; internal notes stay inside.
    note: r.status === 'rejected' ? r.note : null,
  };
}

export function adminView(r: PaymentRow): PaymentAdminView {
  return {
    ...playerView(r),
    checkoutUrl: r.checkout_url,
    expiresAt: r.expires_at,
    destination: r.destination,
    note: r.note,
    partyId: r.party_id,
    username: r.username,
    chain: r.chain,
    accountId: r.account_id,
    walletOperationId: r.wallet_operation_id,
    walletStatus: r.wallet_status,
    providerRef: r.provider_ref,
    providerStatus: r.provider_status,
    payer: r.payer,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    errorCode: r.error_code,
  };
}

export interface Settings {
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  holdDeposits: boolean;
  holdDepositsAbove: number | null;
  holdWithdrawals: boolean;
  holdWithdrawalsAbove: number | null;
  minDeposit: number;
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  maxOpenWithdrawals: number;
  currency: string;
  updatedAt: string | null;
  updatedBy: string | null;
}
