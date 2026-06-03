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
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_DATABASE ?? 'yiji_crm',
      user: process.env.DB_USER ?? 'directus',
      password: process.env.DB_PASSWORD ?? 'directus',
    },
  };
}
