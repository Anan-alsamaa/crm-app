import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Credentials come from the git-ignored `.env.prod.smoke` at the repo root.
 *
 * It is PARSED, never sourced: values may contain spaces, `<`, `>` and other
 * characters a shell would mangle. Each line is `KEY=value`; the value is
 * everything after the FIRST `=`, trimmed, with one pair of matching outer
 * quotes removed. Comments (`#` at line start) and blank lines are skipped.
 * No inline-comment stripping: a `#` inside a password is part of it.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // drop a BOM
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

export const ENV_FILE_NAME = '.env.prod.smoke';

/**
 * Find the env file: `CRM_MCP_ENV_FILE` if set, else the nearest
 * `.env.prod.smoke` walking UP from `startDir`. Walking up is what makes a
 * build inside a git worktree (`.claude/worktrees/<name>/...`) still find the
 * main checkout's file, which is the only copy (it is git-ignored).
 */
export function findEnvFile(startDir: string, override = process.env.CRM_MCP_ENV_FILE): string {
  if (override) {
    if (!existsSync(override)) throw new Error(`CRM_MCP_ENV_FILE points at a missing file`);
    return override;
  }
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, ENV_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${ENV_FILE_NAME} not found above ${startDir} (set CRM_MCP_ENV_FILE)`);
}

export interface Credentials {
  email: string;
  password: string;
}

/** Read the admin credentials. Errors name the KEY that is missing, never a value. */
export function loadCredentials(file: string): Credentials {
  const env = parseEnvFile(readFileSync(file, 'utf8'));
  const email = env.DIRECTUS_ADMIN_EMAIL;
  const password = env.DIRECTUS_ADMIN_PASSWORD;
  if (!email) throw new Error(`DIRECTUS_ADMIN_EMAIL is missing from ${ENV_FILE_NAME}`);
  if (!password) throw new Error(`DIRECTUS_ADMIN_PASSWORD is missing from ${ENV_FILE_NAME}`);
  return { email, password };
}
