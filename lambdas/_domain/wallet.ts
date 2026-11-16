/**
 * The wallet, reached ONLY through its API (never its database). Same
 * `{ headers, path, query, body }` payload and `{ ok, data }` envelope whether
 * the wallet runs as Lambdas (`lambda:Invoke` on `${prefix}<slug>`) or as an
 * HTTP service. Authentication is this service's own wallet credential
 * (`x-api-key`), a wallet user whose roles allow reading parties and creating
 * and transitioning operations — the player's JWT is never forwarded, so the
 * player's own permissions cannot move money here.
 *
 * Three calls, nothing else:
 *   findAccount(partyId)                 parties-get   {id}?include=accounts
 *   createOperation(...)                 operations-create
 *   transition(operationId, event)       operations-transition
 */

import { getConfig, type WalletConfig } from '../_common/config';
import { InsufficientFundsError, NotConfiguredError, UpstreamError } from '../_common/errors';
import { upstream } from '../_common/http';
import { log } from '../_common/logger';

export type WalletEvent = 'COMPLETE' | 'CANCEL' | 'ACCEPT' | 'REJECT';

export interface WalletAccount {
  id: string;
  currencyId: string | null;
  availableBalance: number;
  payoutBalance: number;
  cashableBalance: number | null;
}

export interface WalletOperation {
  id: string | number;
  identifier: string;
  status: string;
  amount: number;
}

interface Envelope<T> { ok: boolean; data?: T; statusCode?: number; error?: { type?: string; message?: string } }

interface Call {
  slug: string;
  method: 'GET' | 'POST';
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

async function cfg(): Promise<WalletConfig> {
  const w = (await getConfig()).wallet;
  if (!w) throw new NotConfiguredError('wallet');
  return w;
}

let lambdaClient: import('@aws-sdk/client-lambda').LambdaClient | undefined;

async function invoke<T>(call: Call): Promise<Envelope<T>> {
  const w = await cfg();
  const timeoutMs = (await getConfig()).upstreamTimeoutMs;
  if (w.mode === 'http') {
    const url = `${w.apiUrl}${call.path}${call.query ? `?${new URLSearchParams(call.query)}` : ''}`;
    const res = await upstream<unknown>('wallet', {
      method: call.method, url, body: call.body, timeoutMs,
      headers: { 'x-api-key': w.apiKey },
      allow: [400, 401, 403, 404, 409, 422],
    });
    // The HTTP runtime unwraps the envelope; rebuild it so both modes look alike.
    if (res.status >= 400) {
      const b = (res.data ?? {}) as { errorCode?: string; message?: string };
      return { ok: false, statusCode: res.status, error: { type: b.errorCode, message: b.message } };
    }
    return { ok: true, data: res.data as T };
  }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  lambdaClient ??= new LambdaClient(w.region ? { region: w.region } : {});
  const payload = {
    headers: { 'x-api-key': w.apiKey },
    ...(call.pathParams ? { path: call.pathParams } : {}),
    ...(call.query ? { query: call.query } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
  };
  const started = Date.now();
  const fnName = `${w.functionPrefix}${call.slug}`;
  try {
    const out = await lambdaClient.send(new InvokeCommand({ FunctionName: fnName, Payload: Buffer.from(JSON.stringify(payload)) }));
    if (out.FunctionError) {
      log.error('wallet function error', { fn: call.slug, err: out.FunctionError, ms: Date.now() - started });
      throw new UpstreamError('wallet', 500);
    }
    const text = Buffer.from(out.Payload ?? new Uint8Array()).toString('utf8');
    const env = JSON.parse(text || '{}') as Envelope<T>;
    log.debug('wallet call', { fn: call.slug, ok: env.ok, status: env.statusCode, ms: Date.now() - started });
    return env;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    log.error('wallet unreachable', { fn: call.slug, err: String(err), ms: Date.now() - started });
    throw new UpstreamError('wallet', 0);
  }
}

function orThrow<T>(env: Envelope<T>, what: string): T {
  if (env.ok && env.data !== undefined) return env.data;
  const status = env.statusCode ?? 502;
  log.warn('wallet refused', { what, status, type: env.error?.type, message: env.error?.message });
  if (status === 422 || status === 409) {
    const type = (env.error?.type ?? '').toUpperCase();
    const msg = (env.error?.message ?? '').toLowerCase();
    if (type.includes('BALANCE') || type.includes('FUNDS') || msg.includes('balance')) throw new InsufficientFundsError();
  }
  throw new UpstreamError('wallet', status);
}

/** The player's wallet account: the first account of their party (what the player app shows). */
export async function findAccount(partyId: string): Promise<WalletAccount> {
  const party = orThrow(await invoke<{ accounts?: Array<Record<string, unknown>>; defaultCurrency?: string }>({
    slug: 'parties-get', method: 'GET', path: `/api/v1/parties/${encodeURIComponent(partyId)}`,
    pathParams: { id: partyId }, query: { include: 'accounts' },
  }), 'parties-get');
  const a = party.accounts?.[0];
  if (!a) throw new UpstreamError('wallet', 404);
  return {
    id: String(a.id),
    currencyId: (a.currencyId as string | undefined) ?? party.defaultCurrency ?? null,
    availableBalance: Number(a.availableBalance ?? 0),
    payoutBalance: Number(a.payoutBalance ?? 0),
    cashableBalance: a.cashableBalance === undefined ? null : Number(a.cashableBalance),
  };
}

export interface CreateOperationInput {
  kind: 'deposit' | 'withdrawal';
  accountId: string;
  amount: number;
  /** Our payment id; the wallet's idempotency key. */
  externalReference: string;
}

/**
 * CREDIT/deposit lands as PENDING (visible, not spendable) until COMPLETE;
 * DEBIT/withdrawal blocks the amount at once until COMPLETE or CANCEL.
 */
export async function createOperation(input: CreateOperationInput): Promise<WalletOperation> {
  const body = {
    amount: input.amount,
    operationType: input.kind === 'deposit' ? 'CREDIT' : 'DEBIT',
    subtype: input.kind,
    destinationAccountId: input.accountId,
    externalReference: input.externalReference,
    origin: 'payments',
  };
  const op = orThrow(await invoke<Record<string, unknown>>({ slug: 'operations-create', method: 'POST', path: '/api/v1/operations', body }), 'operations-create');
  return toOperation(op);
}

export async function transition(operationId: string, event: WalletEvent): Promise<WalletOperation> {
  const op = orThrow(await invoke<Record<string, unknown>>({
    slug: 'operations-transition', method: 'POST',
    path: `/api/v1/operations/${encodeURIComponent(operationId)}/transition`,
    pathParams: { id: operationId }, body: { event },
  }), 'operations-transition');
  return toOperation(op);
}

function toOperation(op: Record<string, unknown>): WalletOperation {
  const inner = (op.operation as Record<string, unknown> | undefined) ?? op;
  return {
    id: (inner.id as string | number) ?? '',
    identifier: String(inner.identifier ?? inner.id ?? ''),
    status: String(inner.status ?? ''),
    amount: Number(inner.amount ?? 0),
  };
}
