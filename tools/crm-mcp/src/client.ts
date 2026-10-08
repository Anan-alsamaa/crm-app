import type { Credentials } from './env.js';
import { readOnlyFetch, type FetchLike } from './guard.js';

/**
 * A Directus session against PRODUCTION that can only read.
 *
 * Every request goes through `readOnlyFetch` (see guard.ts). Tokens live in
 * this object's private fields only; they are never logged, returned or put in
 * an error message. Access tokens expire after ~15 minutes, so a 401 triggers
 * one refresh (or a fresh login) and a single retry.
 */

export class CrmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CrmHttpError';
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface ItemsParams {
  fields?: readonly string[];
  filter?: unknown;
  sort?: readonly string[];
  limit?: number;
  offset?: number;
  aggregate?: Record<string, string>;
  groupBy?: readonly string[];
  meta?: string;
}

/** System collections are served on their own routes, not `/items/...`. */
export function collectionPath(collection: string): string {
  if (collection.startsWith('directus_')) return `/${collection.slice('directus_'.length)}`;
  return `/items/${encodeURIComponent(collection)}`;
}

/** Directus query-string encoding for an items read. */
export function itemsQuery(p: ItemsParams): Query {
  const q: Query = {};
  if (p.fields?.length) q.fields = p.fields.join(',');
  if (p.filter !== undefined) q.filter = JSON.stringify(p.filter);
  if (p.sort?.length) q.sort = p.sort.join(',');
  if (p.limit !== undefined) q.limit = p.limit;
  if (p.offset !== undefined) q.offset = p.offset;
  if (p.meta) q.meta = p.meta;
  for (const [fn, field] of Object.entries(p.aggregate ?? {})) q[`aggregate[${fn}]`] = field;
  (p.groupBy ?? []).forEach((g, i) => (q[`groupBy[${i}]`] = g));
  return q;
}

/** Pull a short, token-free reason out of a Directus/gateway error body. */
function reasonOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { errors?: { message?: string }[]; error?: string };
    const msg = b.errors?.[0]?.message ?? b.error;
    if (msg) return String(msg).slice(0, 300);
  }
  return '';
}

export class CrmClient {
  #access: string | null = null;
  #refresh: string | null = null;

  constructor(
    private readonly credentials: () => Credentials,
    private readonly fetchImpl?: FetchLike,
  ) {}

  private async session(path: '/auth/login' | '/auth/refresh', body: object): Promise<boolean> {
    const res = await readOnlyFetch(
      'POST',
      path,
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      this.fetchImpl,
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { access_token?: string; refresh_token?: string } };
    this.#access = json.data?.access_token ?? null;
    this.#refresh = json.data?.refresh_token ?? null;
    return Boolean(this.#access);
  }

  private async login(): Promise<void> {
    const { email, password } = this.credentials();
    if (!(await this.session('/auth/login', { email, password, mode: 'json' }))) {
      throw new CrmHttpError(401, 'Login to production Directus failed (check .env.prod.smoke)');
    }
  }

  private async renew(): Promise<void> {
    if (
      this.#refresh &&
      (await this.session('/auth/refresh', { refresh_token: this.#refresh, mode: 'json' }))
    ) {
      return;
    }
    await this.login();
  }

  /** GET a path on the production API, JSON in and out. */
  async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
    if (!this.#access) await this.login();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const qsText = qs.toString();
    const target = qsText ? `${path}?${qsText}` : path;

    const send = () =>
      readOnlyFetch(
        'GET',
        target,
        { headers: { authorization: `Bearer ${this.#access}`, accept: 'application/json' } },
        this.fetchImpl,
      );

    let res = await send();
    if (res.status === 401) {
      await this.renew();
      res = await send();
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const why = reasonOf(body);
      throw new CrmHttpError(
        res.status,
        `HTTP ${res.status} on GET ${path}${why ? `: ${why}` : ''}`,
      );
    }
    return body as T;
  }

  /** Read items from a collection; returns the `data` array. */
  async items<T = Record<string, unknown>>(collection: string, p: ItemsParams): Promise<T[]> {
    const body = await this.get<{ data?: T[] }>(collectionPath(collection), itemsQuery(p));
    return body?.data ?? [];
  }

  /** Read one item by id, or null when it does not exist. */
  async item<T = Record<string, unknown>>(
    collection: string,
    id: string,
    fields: readonly string[],
  ): Promise<T | null> {
    try {
      const body = await this.get<{ data?: T }>(
        `${collectionPath(collection)}/${encodeURIComponent(id)}`,
        {
          fields: fields.join(','),
        },
      );
      return body?.data ?? null;
    } catch (err) {
      // Directus answers 403 (not 404) for a missing id, to avoid leaking existence.
      if (err instanceof CrmHttpError && (err.status === 403 || err.status === 404)) return null;
      throw err;
    }
  }
}
