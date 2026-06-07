/*
 * Yiji CRM — local production-like process model (pm2).
 *
 * Supervises the whole stack with NODE_ENV=production, strict config (real
 * secrets from .env.prod), autorestart, and per-process memory caps so a leak
 * or spike restarts ONE process instead of OOM-killing the machine.
 *
 *   Start:   pm2 start ecosystem.config.cjs
 *   Status:  pm2 status   |   Logs: pm2 logs   |   Stop: pm2 delete all
 *
 * Postgres (5432) and Redis (6390) are expected to be already running natively.
 */
const fs = require('fs');
const path = require('path');

const INFRA = __dirname;
const FRONTEND = path.resolve(INFRA, '..', 'crm-app-frontend');
const SERVE = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'serve', 'build', 'main.js');

// Parse .env.prod (real secrets; gitignored).
const env = {};
for (const line of fs.readFileSync(path.join(INFRA, '.env.prod'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

const dist = (app) => path.join(FRONTEND, 'apps', app, 'dist');
const tsService = (name, port, extra) => ({
  name,
  cwd: path.join(INFRA, 'services', name),
  script: 'src/index.ts',
  interpreter: 'node',
  node_args: '--import tsx',
  autorestart: true,
  max_memory_restart: '500M',
  env: Object.assign(
    {
      NODE_ENV: 'production',
      DIRECTUS_INTERNAL_URL: env.DIRECTUS_INTERNAL_URL,
      REDIS_URL: env.REDIS_URL,
      CORS_ORIGIN: env.CORS_ORIGIN,
    },
    port ? { PORT: String(port) } : {},
    extra,
  ),
});
const staticSite = (name, port) => ({
  name,
  script: SERVE,
  interpreter: 'node',
  args: `-s "${dist(name)}" -l ${port} --no-clipboard --no-port-switching`,
  autorestart: true,
  max_memory_restart: '250M',
});

module.exports = {
  apps: [
    {
      name: 'directus',
      cwd: path.join(INFRA, '.directus-prod'),
      script: 'node_modules/directus/cli.js',
      args: 'start',
      interpreter: 'node',
      autorestart: true,
      max_memory_restart: '1200M',
      env: {
        KEY: env.DIRECTUS_KEY,
        SECRET: env.DIRECTUS_SECRET,
        ADMIN_EMAIL: env.DIRECTUS_ADMIN_EMAIL,
        ADMIN_PASSWORD: env.DIRECTUS_ADMIN_PASSWORD,
        PUBLIC_URL: env.DIRECTUS_PUBLIC_URL,
        PORT: '8055',
        DB_CLIENT: 'pg',
        DB_HOST: env.DB_HOST,
        DB_PORT: env.DB_PORT,
        DB_DATABASE: env.DB_DATABASE,
        DB_USER: env.DB_USER,
        DB_PASSWORD: env.DB_PASSWORD,
        REDIS: env.REDIS_URL,
        CACHE_ENABLED: 'true',
        CACHE_STORE: 'redis',
        CACHE_AUTO_PURGE: 'true',
        WEBSOCKETS_ENABLED: 'true',
        CORS_ENABLED: 'true',
        CORS_ORIGIN: env.CORS_ORIGIN,
        STORAGE_LOCATIONS: 'local',
        EXTENSIONS_PATH: path.join(INFRA, 'directus', 'extensions'),
      },
    },
    tsService('socket-gateway', 8080, {
      REDIS_ENABLED: 'true',
      YIJI_JWT_SECRET: env.YIJI_JWT_SECRET,
      SVC_GATEWAY_TOKEN: env.SVC_GATEWAY_TOKEN,
    }),
    tsService('ai-gateway', 8091, {
      SVC_AI_TOKEN: env.SVC_AI_TOKEN,
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      GEMINI_MODEL: env.GEMINI_MODEL,
    }),
    tsService('workers', null, {
      SVC_WORKERS_TOKEN: env.SVC_WORKERS_TOKEN,
      AI_GATEWAY_URL: 'http://localhost:8091',
      SVC_AI_TOKEN: env.SVC_AI_TOKEN,
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT,
      SMTP_FROM: env.SMTP_FROM,
    }),
    staticSite('agent-portal', 5173),
    staticSite('admin-portal', 5174),
    staticSite('chat-widget', 5175),
  ],
};
