#!/usr/bin/env node
/**
 * Harmless smoke against PRODUCTION over stdio: list the tools, then call
 * crm_release_status and crm_query on `vendors` (limit 1). Reads only.
 *
 *   pnpm --filter @yiji/crm-mcp build && pnpm --filter @yiji/crm-mcp smoke
 *
 * Extra calls: pass `name '{"json":"args"}'` pairs, e.g.
 *   node scripts/smoke.mjs crm_coupons '{"limit":1}'
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'dist', 'index.js')],
  stderr: 'inherit',
});
const client = new Client({ name: 'crm-mcp-smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools)
  console.log(`  ${t.name}${t.annotations?.readOnlyHint ? ' [readOnly]' : ''}`);

const extra = process.argv.slice(2);
const calls = extra.length
  ? Array.from({ length: Math.ceil(extra.length / 2) }, (_, i) => [
      extra[2 * i],
      JSON.parse(extra[2 * i + 1] ?? '{}'),
    ])
  : [
      ['crm_release_status', {}],
      [
        'crm_query',
        { collection: 'vendors', fields: ['id', 'name', 'status', 'yiji_vendor_id'], limit: 1 },
      ],
    ];
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} ${JSON.stringify(args)}${res.isError ? ' (isError)' : ''}`);
  for (const c of res.content) if (c.type === 'text') console.log(c.text);
}
await client.close();
