/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gateway URL the demo widget connects to (defaults to http://localhost:8080). */
  readonly VITE_SOCKET_URL?: string;
  /** Dev-only: secret the demo harness signs its JWT with (aligns with the gateway's YIJI_JWT_SECRET). */
  readonly VITE_WIDGET_JWT_SECRET?: string;
  /**
   * Where the store-QR page mints its session (defaults to the page's OWN
   * origin, proxied to the gateway — see walk-in.ts). Set only when the
   * gateway lives somewhere the visitor's phone can actually reach.
   */
  readonly VITE_GATEWAY_HTTP_URL?: string;
  /** The Yiji vendor a store QR code belongs to (defaults to '1'). */
  readonly VITE_WALK_IN_VENDOR_ID?: string;
  /** Where the QR page hands off once a session exists (defaults to '/'). */
  readonly VITE_WALK_IN_CHAT_URL?: string;
  /** Where the chat's close button goes (defaults to the app's `closeapp://`). */
  readonly VITE_WALK_IN_CLOSE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
