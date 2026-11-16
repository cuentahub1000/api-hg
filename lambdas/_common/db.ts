/**
 * Postgres access to the payments database — this service's own store.
 *
 * One module-scope `Client` reused across warm invocations (a Lambda container
 * serves one request at a time, so a pool of one is a client). Connection
 * variables, exactly one name each, no fallbacks:
 *
 *   DB_HOST DB_PORT DB_NAME            where
 *   DB_SECRET_ARN                      Secrets Manager name holding { username, password }
 *     — or, for a local run —  DB_USER DB_PASSWORD
 *   DB_SSL                             `disable` turns TLS off; anything else keeps it on
 *
 * `numeric` columns come back as strings and are converted by the domain
 * layer (`money()`); `int8` stays a string and nothing here uses it.
 */

import { Client, types, type QueryResultRow } from 'pg';
import { log } from './logger';

// timestamptz -> ISO string, not a Date: the envelope would stringify it
// anyway and a string compares/serialises predictably.
types.setTypeParser(1184, (v: string) => new Date(v).toISOString());

export type Sql = string;
export type Params = readonly unknown[];

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: Sql, params?: Params): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(sql: Sql, params?: Params): Promise<T | null>;
  execute(sql: Sql, params?: Params): Promise<number>;
}

type Credentials = { username: string; password: string };

const REQUIRED = ['DB_HOST', 'DB_PORT', 'DB_NAME'] as const;

export function checkEnv(): void {
  const missing = REQUIRED.filter((n) => !process.env[n]);
  if (!process.env.DB_SECRET_ARN && !(process.env.DB_USER && process.env.DB_PASSWORD)) missing.push('DB_SECRET_ARN' as never);
  if (missing.length > 0) throw new Error(`database environment variables are not set: ${missing.join(', ')}`);
  const port = Number(process.env.DB_PORT);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`DB_PORT is not a port number: ${process.env.DB_PORT}`);
}

let credsCache: Promise<Credentials> | undefined;

function credentials(): Promise<Credentials> {
  if (process.env.DB_USER && process.env.DB_PASSWORD) {
    return Promise.resolve({ username: process.env.DB_USER, password: process.env.DB_PASSWORD });
  }
  if (!credsCache) {
    const secretId = process.env.DB_SECRET_ARN!;
    credsCache = (async () => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!res.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
      const parsed = JSON.parse(res.SecretString) as Partial<Credentials>;
      if (!parsed.username || !parsed.password) throw new Error(`secret ${secretId} is missing username/password`);
      return { username: parsed.username, password: parsed.password };
    })().catch((err) => {
      credsCache = undefined;
      throw err;
    });
  }
  return credsCache;
}

class Connection implements Queryable {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  private async handle(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        checkEnv();
        const { username, password } = await credentials();
        const target = { host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: username };
        try {
          const client = new Client({
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            database: process.env.DB_NAME,
            user: username,
            password,
            // Encrypted but unverified inside the VPC (RDS cert is not in Node's
            // trust store); `disable` only for a local Postgres without TLS.
            ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
            connectionTimeoutMillis: 10_000,
          });
          client.on('error', (err) => {
            log.warn('connection error, will reconnect', { ...target, err: String(err) });
            this.client = undefined;
            this.connecting = undefined;
          });
          await client.connect();
          log.info('connected', target);
          this.client = client;
          return client;
        } catch (err) {
          log.error('connect failed', { ...target, err: String(err) });
          throw err;
        }
      })().catch((err) => {
        this.connecting = undefined;
        throw err;
      });
    }
    return this.connecting;
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: Sql, params: Params = []): Promise<T[]> {
    const client = await this.handle();
    try {
      return (await client.query<T>(sql, params as unknown[])).rows;
    } catch (err) {
      log.error('query failed', { sql: sql.replace(/\s+/g, ' ').slice(0, 200), err: String(err) });
      throw err;
    }
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: Sql, params: Params = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async execute(sql: Sql, params: Params = []): Promise<number> {
    const client = await this.handle();
    try {
      return (await client.query(sql, params as unknown[])).rowCount ?? 0;
    } catch (err) {
      log.error('statement failed', { sql: sql.replace(/\s+/g, ' ').slice(0, 200), err: String(err) });
      throw err;
    }
  }

  /** Run `fn` inside BEGIN/COMMIT; ROLLBACK on throw. */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.handle();
    await client.query('BEGIN');
    try {
      const out = await fn(this);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
      throw err;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (c) await c.end().catch(() => undefined);
  }
}

export const db = new Connection();
