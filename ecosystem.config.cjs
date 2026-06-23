/*
 * Yiji CRM — PM2 process model for the HYBRID deployment (the final, decided
 * model; see docs/DEPLOY-HYBRID.md). PM2 supervises ONLY the three Node app
 * services. Postgres, Redis, and Directus run in Docker; the agent/admin portals
 * are static builds served by nginx; the chat widget is an embeddable bundle.
 *
 * Env (real secrets) is inherited from the shell — source .env.prod before start:
 *   set -a && . ./.env.prod && set +a
 *   pm2 start ecosystem.config.cjs   |   pm2 reload ecosystem.config.cjs   |   pm2 save
 *
 * Each service runs its own `start` script (tsx src/index.ts) under
 * NODE_ENV=production, so the prod Zod guards (strong secrets, exact CORS,
 * redis, SMTP) are exercised exactly as in production.
 *
 * Port note: socket-gateway binds PORT *and* PORT+1 (8080 socket + 8081 http),
 * so ai-gateway is on 8085 to avoid a single-host clash.
 */
module.exports = {
  apps: [
    {
      name: 'socket-gateway',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/socket-gateway start',
      interpreter: 'none', // pnpm is directly executable
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production', PORT: '8080', OTEL_SERVICE_NAME: 'socket-gateway' },
    },
    {
      name: 'ai-gateway',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/ai-gateway start',
      interpreter: 'none',
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production', PORT: '8085', OTEL_SERVICE_NAME: 'ai-gateway' },
    },
    {
      name: 'workers',
      cwd: __dirname,
      script: 'pnpm',
      args: '--filter @yiji/workers start',
      interpreter: 'none',
      autorestart: true,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production', OTEL_SERVICE_NAME: 'workers' },
    },
  ],
};
