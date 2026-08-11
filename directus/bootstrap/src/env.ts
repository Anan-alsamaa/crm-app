/** Bootstrap environment (admin auth + DB connection for raw constraint SQL). */
export interface BootstrapEnv {
  directusUrl: string;
  adminEmail: string;
  adminPassword: string;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    /** Managed Postgres (RDS/Cloud SQL) usually refuses plaintext. */
    ssl?: { rejectUnauthorized: boolean };
  };
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadEnv(): BootstrapEnv {
  return {
    directusUrl: process.env.DIRECTUS_INTERNAL_URL ?? 'http://localhost:8055',
    adminEmail: req('DIRECTUS_ADMIN_EMAIL'),
    adminPassword: req('DIRECTUS_ADMIN_PASSWORD'),
    db: {
      /* DB_HOST/DB_PORT are the CONTAINER's view of Postgres (docker-compose
       * passes them to Directus as `postgres:5432`). This bootstrap runs on the
       * HOST, where that name does not resolve and that port belongs to whatever
       * else is installed locally — so the two vantage points need separate
       * values. DB_HOST_EXTERNAL/DB_PORT_EXTERNAL are the host-side pair,
       * matching the `ports:` mapping in docker-compose.yml.
       *
       * Falling back to DB_HOST/DB_PORT keeps a deployment that runs bootstrap
       * INSIDE the network (or against a managed Postgres, where there is only
       * one address) working unchanged. */
      host: process.env.DB_HOST_EXTERNAL ?? process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT_EXTERNAL ?? process.env.DB_PORT ?? 5432),
      database: process.env.DB_DATABASE ?? 'yiji_crm',
      user: process.env.DB_USER ?? 'directus',
      password: process.env.DB_PASSWORD ?? 'directus',
      // The constraints step talks to Postgres DIRECTLY (raw index/constraint
      // SQL the Directus API cannot express), so it needs its own TLS setting.
      // RDS with rds.force_ssl=1 rejects a plaintext connection outright, and
      // the failure surfaces only at the very end of an otherwise successful
      // bootstrap. `rejectUnauthorized: false` matches what Directus itself is
      // configured with (DB_SSL__REJECT_UNAUTHORIZED=false) — the RDS CA is not
      // in the local trust store.
      ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  };
}
