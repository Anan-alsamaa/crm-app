import { describe, expect, it } from 'vitest';
import { checkQuery, MAX_LIMIT, QueryRefused } from '../src/query.js';

describe('crm_query checks', () => {
  it('accepts an ordinary read and caps the limit', () => {
    const q = checkQuery({
      collection: 'vendors',
      fields: ['id', 'name'],
      sort: ['-date_created'],
      limit: 5000,
    });
    expect(q).toMatchObject({ collection: 'vendors', fields: ['id', 'name'], limit: MAX_LIMIT });
    expect(checkQuery({ collection: 'tickets' }).fields).toEqual(['*']);
    expect(checkQuery({ collection: 'tickets', fields: ['assigned_agent.first_name'] }).limit).toBe(
      25,
    );
  });

  it.each([
    'directus_settings',
    'directus_files',
    'directus_activity',
    'directus_sessions',
    'directus_permissions',
  ])('refuses system collection %s', (collection) => {
    expect(() => checkQuery({ collection })).toThrow(QueryRefused);
  });

  it('allows directus_users only with the safe fields', () => {
    expect(checkQuery({ collection: 'directus_users' }).fields).toEqual([
      'id',
      'first_name',
      'last_name',
      'email',
      'role',
      'role.id',
      'role.name',
      'status',
    ]);
    expect(() =>
      checkQuery({
        collection: 'directus_users',
        fields: ['id', 'email'],
        filter: { role: { name: { _eq: 'Admin' } } },
      }),
    ).not.toThrow();
    for (const f of ['password', 'token', 'tfa_secret', '*', 'auth_data', 'external_identifier']) {
      expect(() => checkQuery({ collection: 'directus_users', fields: [f] })).toThrow(QueryRefused);
    }
    expect(() =>
      checkQuery({ collection: 'directus_users', filter: { password: { _starts_with: 'a' } } }),
    ).toThrow(QueryRefused);
    expect(() => checkQuery({ collection: 'directus_users', sort: ['token'] })).toThrow(
      QueryRefused,
    );
  });

  it('refuses secret fields, nested wildcards and secret filters on any collection', () => {
    expect(() => checkQuery({ collection: 'tickets', fields: ['assigned_agent.*'] })).toThrow(
      /nested wildcard/,
    );
    expect(() =>
      checkQuery({ collection: 'tickets', fields: ['assigned_agent.password'] }),
    ).toThrow(QueryRefused);
    expect(() => checkQuery({ collection: 'tickets', fields: ['user_created.token'] })).toThrow(
      QueryRefused,
    );
    expect(() =>
      checkQuery({
        collection: 'tickets',
        filter: { assigned_agent: { token: { _nnull: true } } },
      }),
    ).toThrow(QueryRefused);
    expect(() => checkQuery({ collection: 'Tickets; drop' })).toThrow(QueryRefused);
    expect(() => checkQuery({ collection: 'tickets', fields: ['id,subject'] })).toThrow(
      QueryRefused,
    );
  });
});
