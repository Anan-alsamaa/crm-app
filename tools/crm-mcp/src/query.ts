import { SECRET_KEY } from './format.js';

/**
 * Validation for `crm_query`, the generic read. Kept pure so it is unit-tested
 * without a network.
 *
 * Rules:
 *  - Collection names are plain identifiers.
 *  - System collections (`directus_*`) are refused, except:
 *      directus_users  — only the fields id, first_name, last_name, email,
 *                        role (and role.id / role.name), status
 *      directus_roles  — only id, name
 *  - No field path, sort key or filter key may name a secret-looking field
 *    (password, token, secret, credential, api key, ...).
 *  - A wildcard is allowed only as a whole top-level `*`; a NESTED wildcard
 *    (`assigned_agent.*`) would expand a user record, so it is refused.
 *  - On a system collection, no wildcard at all.
 *  - limit defaults to 25 and is capped at 200.
 */

export const MAX_LIMIT = 200;

const SYSTEM_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  directus_users: [
    'id',
    'first_name',
    'last_name',
    'email',
    'role',
    'role.id',
    'role.name',
    'status',
  ],
  directus_roles: ['id', 'name'],
};

export class QueryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryRefused';
  }
}

export interface QueryInput {
  collection: string;
  fields?: string[];
  filter?: unknown;
  sort?: string[];
  limit?: number;
}

export interface CheckedQuery {
  collection: string;
  fields: string[];
  filter?: unknown;
  sort: string[];
  limit: number;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const FIELD_PATH = /^(\*|[A-Za-z_][A-Za-z0-9_]*(\.([A-Za-z_][A-Za-z0-9_]*|\*))*)$/;

function checkSegments(path: string, what: string): void {
  for (const seg of path.split('.')) {
    if (seg !== '*' && SECRET_KEY.test(seg)) {
      throw new QueryRefused(`Refused: ${what} "${path}" names a secret field`);
    }
  }
}

/** Every key in a filter object, at any depth (operators like `_eq` included). */
function filterKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => filterKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      filterKeys(v, out);
    }
  }
  return out;
}

export function checkQuery(input: QueryInput): CheckedQuery {
  const collection = input.collection.trim();
  if (!IDENT.test(collection))
    throw new QueryRefused(`Refused: "${collection}" is not a collection name`);

  const system = collection.startsWith('directus_');
  const allowed = system ? SYSTEM_ALLOWED[collection] : undefined;
  if (system && !allowed) {
    throw new QueryRefused(
      `Refused: system collection ${collection} is not readable here (allowed: ${Object.keys(SYSTEM_ALLOWED).join(', ')})`,
    );
  }

  const fields = (input.fields?.length ? input.fields : allowed ? [...allowed] : ['*']).map((f) =>
    f.trim(),
  );
  for (const f of fields) {
    if (!FIELD_PATH.test(f)) throw new QueryRefused(`Refused: "${f}" is not a field path`);
    checkSegments(f, 'field');
    if (f.includes('*') && f !== '*') {
      throw new QueryRefused(
        `Refused: nested wildcard "${f}" — name the related fields explicitly`,
      );
    }
    if (allowed && !allowed.includes(f)) {
      throw new QueryRefused(
        `Refused: field "${f}" on ${collection} (allowed: ${allowed.join(', ')})`,
      );
    }
  }

  const sort = (input.sort ?? []).map((s) => s.trim()).filter(Boolean);
  for (const s of sort) {
    const bare = s.replace(/^-/, '');
    if (!FIELD_PATH.test(bare) || bare.includes('*'))
      throw new QueryRefused(`Refused: "${s}" is not a sort key`);
    checkSegments(bare, 'sort key');
    if (allowed && !allowed.includes(bare))
      throw new QueryRefused(`Refused: sort "${s}" on ${collection}`);
  }

  if (input.filter !== undefined) {
    if (typeof input.filter !== 'object' || input.filter === null) {
      throw new QueryRefused('Refused: filter must be a JSON object');
    }
    // A nested filter names one path segment per level ({role: {name: ...}}).
    const allowedSegments = new Set((allowed ?? []).flatMap((a) => a.split('.')));
    for (const k of filterKeys(input.filter)) {
      for (const seg of k.split('.')) {
        if (SECRET_KEY.test(seg))
          throw new QueryRefused(`Refused: filter key "${k}" names a secret field`);
      }
      if (allowed && !k.startsWith('_') && !k.split('.').every((s) => allowedSegments.has(s))) {
        throw new QueryRefused(
          `Refused: filter on "${k}" for ${collection} (allowed: ${allowed.join(', ')})`,
        );
      }
    }
  }

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), MAX_LIMIT);
  return { collection, fields, filter: input.filter, sort, limit };
}
