/**
 * Caller identity and audience (same model as api-engagement).
 *
 * One way in: `headers.authorization = "Bearer <jwt>"`, verified locally with
 * the platform secret. Pre-decoded shapes (`x-auth-decoded-token`,
 * `securityContext`) are rejected: nothing sits in front of these functions,
 * so believing one would let any caller with invoke rights assert any
 * identity. This service never reads the security database; `x-api-key` is
 * not accepted.
 *
 * Audience comes from the token's `metadata.partyType`:
 *
 *   player    — partyType `person` / `P`. Acts only on its own payments and
 *               its own wallet account, both resolved from `ctx.partyId`.
 *   operator  — any other party type. Sees and decides payments of parties
 *               inside its own subtree (`isDescendant` / `chainScope`).
 *
 * The provider webhook is a third caller with no JWT at all; it is verified by
 * HMAC in `lambdas/webhook` and never goes through this module.
 */

import { AuthError, ForbiddenError } from './errors';
import { fullChainOf } from './chain';
import * as token from './token';

export type Audience = 'player' | 'operator';

export interface SecurityContext {
  identifier: string;
  username: string;
  /** Party identifier (cuid). The subscriber id everywhere downstream. */
  partyId: string;
  chain: string;
  fullChain: string;
  partyType: string;
  audience: Audience;
  displayName: string;
  locale?: string;
  brand?: string;
  /** The player's address and browser as the front-end saw them (`x-player-ip`, `x-player-user-agent`); hints for the record, never identity. */
  ip?: string;
  userAgent?: string;
}

export interface PaymentsEvent {
  headers?: Record<string, unknown>;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  [key: string]: unknown;
}

export async function contextFromEvent(event: PaymentsEvent): Promise<SecurityContext> {
  const headers = normalizeHeaders(event.headers);
  const authorization = headers.authorization ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const payload = await token.verify(authorization.slice(7).trim());
    return fromDecodedToken(payload, headers);
  }
  if (event.securityContext !== undefined || event.x_decoded_token !== undefined || headers['x-auth-decoded-token']) {
    throw new AuthError('pre-decoded identities are not accepted: pass a Bearer JWT');
  }
  throw new AuthError('no auth provided: pass Authorization');
}

export function fromDecodedToken(payload: Record<string, unknown>, headers: Record<string, string> = {}): SecurityContext {
  if (!payload || typeof payload !== 'object') throw new AuthError('decoded token is not an object');
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new AuthError('decoded token metadata is not an object');

  const partyId = str(metadata.partyId) || str(payload.partyId);
  if (!partyId) throw new AuthError('decoded token missing partyId');
  const chain = str(metadata.chain);
  const partyType = str(metadata.partyType);
  const audience: Audience = partyType === 'person' || partyType === 'P' ? 'player' : 'operator';

  return {
    identifier: str(payload.identifier) || str(payload.username),
    username: str(payload.username),
    partyId,
    chain,
    fullChain: str(payload.fullChain) || fullChainOf(chain, partyId),
    partyType,
    audience,
    displayName: str(payload.name) || str(payload.username) || partyId,
    // Locale and brand are not claims today; the front-end forwards what it
    // knows (cookie-derived) as plain headers. Both are hints, never identity.
    locale: headers['x-player-locale'] || undefined,
    brand: headers['x-player-brand'] || undefined,
    ip: (headers['x-player-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) || undefined,
    userAgent: (headers['x-player-user-agent'] || headers['user-agent'] || '').slice(0, 300) || undefined,
  };
}

export function requireAudience(ctx: SecurityContext, audience: Audience | 'any'): void {
  if (audience === 'any') return;
  if (ctx.audience !== audience) throw new ForbiddenError(`this endpoint is for ${audience}s`);
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (v !== null && v !== undefined) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
