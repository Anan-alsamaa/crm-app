/*
 * Yiji CRM — PM2 process model (final deployment architecture).
 *
 * PM2 supervises ONLY the three Node services. The infra tier (Postgres, Redis,
 * Directus) runs in Docker (deploy/docker-compose.infra.yml) on loopback, and
 * the SPAs are served by nginx (deploy/nginx/) — neither is a PM2 process here.
 *
 *   Layer  Component         Runs as   Listens (loopback)
 *   -----  ----------------  --------  --------------------------------------
 *   App    socket-gateway    PM2       127.0.0.1:8080 (socket) + 8081 (http)
 *   App    ai-gateway        PM2       127.0.0.1:8085
 *   App    workers           PM2       — (BullMQ consumer, no port)
 *
 *   Start:   pm2 start ecosystem.config.cjs
 *   Status:  pm2 status   |   Logs: pm2 logs   |   Reload: pm2 reload all
 *   Boot:    pm2 startup && pm2 save     (survive server reboots)
 *
 * Secrets come from .env.prod (gitignored). The infra tier must be up first:
 *   docker compose -f deploy/docker-compose.infra.yml --env-file .env.prod up -d
 */
const fs = require('fs');
const path = require('path');

const INFRA = __dirname;

// Parse .env.prod (real secrets; gitignored).
const env = {};
for (const line of fs.readFileSync(path.join(INFRA, '.env.prod'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

// Loopback endpoints of the Dockerised infra tier.
const REDIS_URL = env.REDIS_URL || 'redis://127.0.0.1:6379';
const DIRECTUS_INTERNAL_URL = env.DIRECTUS_INTERNAL_URL || 'http://127.0.0.1:8055';
const AI_GATEWAY_PORT = env.AI_GATEWAY_PORT || '8085';

const tsService = (name, extra) => ({
  name,
  cwd: path.join(INFRA, 'services', name),
  script: 'src/index.ts',
  interpreter: 'node',
  node_args: '--import tsx',
  autorestart: true,
  max_memory_restart: '500M',
  // Back off if a service crash-loops (bad config / dependency down).
  exp_backoff_restart_delay: 200,
  env: Object.assign(
    {
      NODE_ENV: 'production',
      DIRECTUS_INTERNAL_URL,
      REDIS_URL,
      CORS_ORIGIN: env.CORS_ORIGIN,
    },
    extra,
  ),
});

module.exports = {
  apps: [
    // Socket.IO on PORT (8080); health/metrics/webhooks on PORT+1 (8081).
    tsService('socket-gateway', {
      PORT: '8080',
      REDIS_ENABLED: 'true',
      DIRECTUS_URL: env.DIRECTUS_PUBLIC_URL,
      YIJI_JWT_SECRET: env.YIJI_JWT_SECRET,
      SVC_GATEWAY_TOKEN: env.SVC_GATEWAY_TOKEN,
      YIJI_WEBHOOK_SECRET: env.YIJI_WEBHOOK_SECRET || '',
      WEBHOOK_TOLERANCE_SEC: env.WEBHOOK_TOLERANCE_SEC || '300',
      ATTACHMENT_MAX_BYTES: env.ATTACHMENT_MAX_BYTES || '10485760',
      ATTACHMENT_ALLOWED_MIME:
        env.ATTACHMENT_ALLOWED_MIME ||
        'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain',
      MSG_RATE_CAPACITY: env.MSG_RATE_CAPACITY || '20',
      MSG_RATE_REFILL_PER_SEC: env.MSG_RATE_REFILL_PER_SEC || '5',
    }),
    tsService('ai-gateway', {
      PORT: AI_GATEWAY_PORT,
      SVC_AI_TOKEN: env.SVC_AI_TOKEN,
      DIRECTUS_AI_TOKEN: env.DIRECTUS_AI_TOKEN || '',
      GEMINI_API_KEY: env.GEMINI_API_KEY || '',
      GEMINI_MODEL: env.GEMINI_MODEL || 'gemini-2.5-flash',
      // C-2 commerce proxy (empty URL → server-side mock client).
      YIJI_API_URL: env.YIJI_API_URL || '',
      YIJI_API_KEY: env.YIJI_API_KEY || '',
    }),
    tsService('workers', {
      SVC_WORKERS_TOKEN: env.SVC_WORKERS_TOKEN,
      AI_GATEWAY_URL: `http://127.0.0.1:${AI_GATEWAY_PORT}`,
      SVC_AI_TOKEN: env.SVC_AI_TOKEN,
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT || '587',
      SMTP_USER: env.SMTP_USER || '',
      SMTP_PASSWORD: env.SMTP_PASSWORD || '',
      SMTP_FROM: env.SMTP_FROM || 'Yiji Support <support@example.com>',
    }),
  ],
};
