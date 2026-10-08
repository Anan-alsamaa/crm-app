#!/usr/bin/env node
/**
 * crm-prod — a READ-ONLY MCP server for the PRODUCTION Sara/Yiji CRM.
 *
 * stdio transport: stdout is the protocol, so this process never writes
 * anything else there. Diagnostics go to stderr and never carry credentials.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CrmClient } from './client.js';
import { findEnvFile, loadCredentials } from './env.js';
import { buildServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> tools/crm-mcp -> tools -> repo root
const repoRoot = path.resolve(here, '..', '..', '..');

let client: CrmClient | null = null;
const getClient = (): CrmClient => {
  if (!client) {
    const file = findEnvFile(repoRoot);
    client = new CrmClient(() => loadCredentials(file));
  }
  return client;
};

const server = buildServer({ client: getClient, repoRoot });
await server.connect(new StdioServerTransport());
process.stderr.write('crm-prod MCP server ready (PRODUCTION, read-only)\n');
