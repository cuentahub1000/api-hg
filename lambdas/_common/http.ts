/**
 * Outbound HTTP to the payment provider and (in HTTP mode) the wallet.
 *
 * Every call is bounded by a timeout, and every failure is logged with the
 * upstream status and body but surfaced to the caller as a bare
 * `UpstreamError(product)`: the body of a provider 500 is for our logs, not
 * for a player's browser.
 */

import { UpstreamError } from './errors';
import { log } from './logger';

export interface UpstreamRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Statuses that are an answer, not a failure (e.g. 404 on a lookup). */
  allow?: number[];
}

export interface UpstreamResponse<T = unknown> {
  status: number;
  data: T;
}

export async function upstream<T = unknown>(product: string, req: UpstreamRequest): Promise<UpstreamResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(req.headers ?? {}),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok && !(req.allow ?? []).includes(res.status)) {
      log.warn('upstream error', {
        product,
        method: req.method ?? 'GET',
        path: safePath(req.url),
        status: res.status,
        ms: Date.now() - started,
        body: typeof data === 'string' ? data.slice(0, 500) : data,
      });
      throw new UpstreamError(product, res.status);
    }
    log.debug('upstream ok', { product, method: req.method ?? 'GET', path: safePath(req.url), status: res.status, ms: Date.now() - started });
    return { status: res.status, data: data as T };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    log.error('upstream unreachable', { product, path: safePath(req.url), err: String(err), ms: Date.now() - started });
    throw new UpstreamError(product, 0);
  } finally {
    clearTimeout(timer);
  }
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return '?';
  }
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.append(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}
