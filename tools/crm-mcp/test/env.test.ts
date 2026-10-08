import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findEnvFile, loadCredentials, parseEnvFile } from '../src/env.js';

describe('parseEnvFile', () => {
  it('keeps spaces, <>, = and # inside values, strips one pair of quotes, skips comments', () => {
    const env = parseEnvFile(
      [
        '# a comment',
        '',
        'DIRECTUS_ADMIN_EMAIL=admin@example.com',
        'DIRECTUS_ADMIN_PASSWORD=p a<s>s=w#rd ',
        'QUOTED="hello world"',
        "SINGLE='<x y>'",
        'export EXPORTED=1',
        'EMPTY=',
        'not a line',
      ].join('\r\n'),
    );
    expect(env).toEqual({
      DIRECTUS_ADMIN_EMAIL: 'admin@example.com',
      DIRECTUS_ADMIN_PASSWORD: 'p a<s>s=w#rd',
      QUOTED: 'hello world',
      SINGLE: '<x y>',
      EXPORTED: '1',
      EMPTY: '',
    });
  });

  it('loads credentials from a file found by walking up, and names missing keys without values', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'crm-mcp-'));
    const deep = path.join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      path.join(root, '.env.prod.smoke'),
      'DIRECTUS_ADMIN_EMAIL=e@x\nDIRECTUS_ADMIN_PASSWORD=has <angle> and spaces\n',
    );
    const file = findEnvFile(deep, '');
    expect(file).toBe(path.join(root, '.env.prod.smoke'));
    expect(loadCredentials(file)).toEqual({ email: 'e@x', password: 'has <angle> and spaces' });

    writeFileSync(path.join(root, '.env.prod.smoke'), 'DIRECTUS_ADMIN_EMAIL=e@x\n');
    expect(() => loadCredentials(file)).toThrow(/DIRECTUS_ADMIN_PASSWORD is missing/);
  });
});
