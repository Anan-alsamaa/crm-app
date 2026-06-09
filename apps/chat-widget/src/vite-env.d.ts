/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gateway URL the demo widget connects to (defaults to http://localhost:8080). */
  readonly VITE_SOCKET_URL?: string;
  /** Dev-only: secret the demo harness signs its JWT with (aligns with the gateway's YIJI_JWT_SECRET). */
  readonly VITE_WIDGET_JWT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
