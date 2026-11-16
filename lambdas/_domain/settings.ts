/**
 * Per-tenant hold and limit settings. The tenant is the root of the player's
 * (or operator's) chain, so one brand's holds never leak into another's. A
 * tenant with no row gets the defaults below (the same values the SQL
 * defaults carry) until a root operator saves the form once.
 */

import { db } from '../_common/db';
import { getConfig } from '../_common/config';
import { ValidationError } from '../_common/errors';
import { moneyParam, money, type Settings } from './types';

interface Row {
  tenant: string;
  deposits_enabled: boolean;
  withdrawals_enabled: boolean;
  hold_deposits: boolean;
  hold_deposits_above: string | null;
  hold_withdrawals: boolean;
  hold_withdrawals_above: string | null;
  min_deposit: string;
  max_deposit: string;
  min_withdrawal: string;
  max_withdrawal: string;
  max_open_withdrawals: number;
  updated_at: string;
  updated_by: string | null;
}

export const DEFAULTS: Omit<Settings, 'currency' | 'updatedAt' | 'updatedBy'> = {
  depositsEnabled: true,
  withdrawalsEnabled: true,
  holdDeposits: false,
  holdDepositsAbove: null,
  holdWithdrawals: true,
  holdWithdrawalsAbove: null,
  minDeposit: 1000,
  maxDeposit: 2_000_000,
  minWithdrawal: 1000,
  maxWithdrawal: 1_000_000,
  maxOpenWithdrawals: 1,
};

export const WRITABLE = Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>;

export async function getSettings(tenant: string): Promise<Settings> {
  const cfg = await getConfig();
  const row = await db.one<Row>('SELECT * FROM payment_settings WHERE tenant = $1', [tenant]);
  if (!row) return { ...DEFAULTS, currency: cfg.currency, updatedAt: null, updatedBy: null };
  return {
    depositsEnabled: row.deposits_enabled,
    withdrawalsEnabled: row.withdrawals_enabled,
    holdDeposits: row.hold_deposits,
    holdDepositsAbove: money(row.hold_deposits_above),
    holdWithdrawals: row.hold_withdrawals,
    holdWithdrawalsAbove: money(row.hold_withdrawals_above),
    minDeposit: money(row.min_deposit) ?? DEFAULTS.minDeposit,
    maxDeposit: money(row.max_deposit) ?? DEFAULTS.maxDeposit,
    minWithdrawal: money(row.min_withdrawal) ?? DEFAULTS.minWithdrawal,
    maxWithdrawal: money(row.max_withdrawal) ?? DEFAULTS.maxWithdrawal,
    maxOpenWithdrawals: row.max_open_withdrawals,
    currency: cfg.currency,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Validate a partial body against the writable fields and persist the merge. */
export async function updateSettings(tenant: string, body: Record<string, unknown>, by: string): Promise<Settings> {
  const current = await getSettings(tenant);
  const next = { ...current };
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!WRITABLE.includes(key as keyof typeof DEFAULTS)) { errors.push(`'${key}' is not a setting`); continue; }
    const k = key as keyof typeof DEFAULTS;
    const def = DEFAULTS[k];
    if (typeof def === 'boolean') {
      if (typeof raw !== 'boolean') errors.push(`'${key}' must be a boolean`);
      else (next as Record<string, unknown>)[k] = raw;
    } else if (k === 'maxOpenWithdrawals') {
      if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > 50) errors.push(`'${key}' must be an integer between 1 and 50`);
      else next.maxOpenWithdrawals = raw as number;
    } else {
      // amounts; the two `*Above` thresholds accept null (= never)
      if (raw === null && (k === 'holdDepositsAbove' || k === 'holdWithdrawalsAbove')) { (next as Record<string, unknown>)[k] = null; continue; }
      const n = typeof raw === 'number' ? raw : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1e12) errors.push(`'${key}' must be a non-negative amount`);
      else (next as Record<string, unknown>)[k] = Math.round(n * 100) / 100;
    }
  }
  if (next.minDeposit > next.maxDeposit) errors.push("'minDeposit' must not exceed 'maxDeposit'");
  if (next.minWithdrawal > next.maxWithdrawal) errors.push("'minWithdrawal' must not exceed 'maxWithdrawal'");
  if (errors.length) throw new ValidationError('Validation failed', errors);

  const opt = (v: number | null) => (v === null ? null : moneyParam(v));
  await db.execute(
    `INSERT INTO payment_settings (tenant, deposits_enabled, withdrawals_enabled, hold_deposits, hold_deposits_above,
       hold_withdrawals, hold_withdrawals_above, min_deposit, max_deposit, min_withdrawal, max_withdrawal,
       max_open_withdrawals, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13)
     ON CONFLICT (tenant) DO UPDATE SET
       deposits_enabled = EXCLUDED.deposits_enabled, withdrawals_enabled = EXCLUDED.withdrawals_enabled,
       hold_deposits = EXCLUDED.hold_deposits, hold_deposits_above = EXCLUDED.hold_deposits_above,
       hold_withdrawals = EXCLUDED.hold_withdrawals, hold_withdrawals_above = EXCLUDED.hold_withdrawals_above,
       min_deposit = EXCLUDED.min_deposit, max_deposit = EXCLUDED.max_deposit,
       min_withdrawal = EXCLUDED.min_withdrawal, max_withdrawal = EXCLUDED.max_withdrawal,
       max_open_withdrawals = EXCLUDED.max_open_withdrawals, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tenant, next.depositsEnabled, next.withdrawalsEnabled, next.holdDeposits, opt(next.holdDepositsAbove),
      next.holdWithdrawals, opt(next.holdWithdrawalsAbove), moneyParam(next.minDeposit), moneyParam(next.maxDeposit),
      moneyParam(next.minWithdrawal), moneyParam(next.maxWithdrawal), next.maxOpenWithdrawals, by],
  );
  return getSettings(tenant);
}

/** Does this amount wait for an operator, under these settings? */
export function needsHold(kind: 'deposit' | 'withdrawal', amount: number, s: Settings): boolean {
  const always = kind === 'deposit' ? s.holdDeposits : s.holdWithdrawals;
  const above = kind === 'deposit' ? s.holdDepositsAbove : s.holdWithdrawalsAbove;
  return always || (above !== null && amount >= above);
}
