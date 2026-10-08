import type { FastifyInstance } from 'fastify';
import { VENDOR_KEY_PATTERN, YIJI_VENDOR_KEY, type VendorSecrets } from '@yiji/shared-types';
import { verifyWebhookSignature } from './webhook.js';

/**
 * PER-VENDOR AUTHENTICATION (MV-3, EMA-72).
 *
 * Every vendor has its own webhook secret and its own chat-login (customer
 * JWT) secret, read from service configuration by the naming convention in
 * `@yiji/shared-types` `vendor-secrets.ts` (docs/VENDOR-SECRETS.md). This
 * module wires those secrets to the two places that need them: the
 * `/webhooks/<key>` receivers and the customer-token verifier/signer.
 */

/** A vendor as the webhook route needs it. */
export interface WebhookVendor {
  id: string;
  yijiVendorId: string;
}

/**
 * The JWT secret of a vendor named by its platform id (`yiji_vendor_id` — the
 * value a customer token carries as `vendor_id`). Null = refuse.
 *
 * THE DEFAULT VENDOR IS YIJI, resolved without a database round trip: its
 * secret is `YIJI_JWT_SECRET`, exactly as before MV-3, so a Yiji login cannot
 * be broken by a vendors-table read failing.
 *
 * Every OTHER vendor id is looked up (`lookupKey` → its `webhook_path_key`,
 * active vendors only) and gets ITS secret or nothing. A non-default vendor
 * whose key is somehow `yiji` is refused: Yiji's secret belongs to the default
 * vendor alone, or a token signed for Yiji could be served as another vendor.
 *
 * Positive lookups are cached briefly (a vendor's key does not change under a
 * running chat); misses and failures are not, so a newly added vendor works on
 * its first login.
 */
export function createVendorJwtSecrets(opts: {
  secrets: VendorSecrets;
  defaultVendorId: string;
  lookupKey: (yijiVendorId: string) => Promise<string | null>;
  ttlMs?: number;
  now?: () => number;
}): (yijiVendorId: string) => Promise<string | null> {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { key: string; at: number }>();
  return async (yijiVendorId) => {
    const id = yijiVendorId.trim();
    if (!id) return null;
    if (id === opts.defaultVendorId) return opts.secrets.jwtSecret(YIJI_VENDOR_KEY);
    let key = cache.get(id);
    if (!key || now() - key.at > ttl) {
      const found = (await opts.lookupKey(id))?.trim().toLowerCase();
      if (!found) return null;
      key = { key: found, at: now() };
      cache.set(id, key);
    }
    if (key.key === YIJI_VENDOR_KEY) return null;
    return opts.secrets.jwtSecret(key.key);
  };
}

/** What a verified webhook hands to per-vendor processing. */
export interface VendorWebhookEvent {
  vendorKey: string;
  vendor: WebhookVendor | null;
  event: string;
  body: unknown;
}

export interface VendorWebhookDeps {
  /** Today's `YIJI_WEBHOOK_SECRET` — `/webhooks/yiji` is unchanged. */
  yijiWebhookSecret: string;
  secrets: VendorSecrets;
  /** The ACTIVE vendor whose `webhook_path_key` is `key`, or null. */
  findVendorByKey: (key: string) => Promise<WebhookVendor | null>;
  toleranceSec: number;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  /**
   * Per-vendor processing, run after the signature is verified. Today nothing
   * is wired (the route acknowledges, as `/webhooks/yiji` always has); this is
   * the seam a vendor's event handling plugs into.
   */
  onEvent?: (e: VendorWebhookEvent) => Promise<void> | void;
}

const rawBodyOf = (req: unknown): string => (req as { rawBody?: string }).rawBody ?? '';

/**
 * Register the inbound webhook receivers.
 *
 *  - `POST /webhooks/yiji` — the Yiji vendor's route, behaviour unchanged:
 *    503 until `YIJI_WEBHOOK_SECRET` is set, 401 on a bad signature, 202.
 *  - `POST /webhooks/:vendorKey` — every other vendor. 404 for a key that is
 *    not an active vendor's `webhook_path_key`, 503 when that vendor has no
 *    configured secret, 401 when the signature is not THAT vendor's, 202.
 *
 * Same signing scheme for all: `X-Yiji-Signature: sha256=<hmac>` over
 * `<X-Yiji-Timestamp>.<raw body>`. The static `/webhooks/yiji` route always
 * wins over the parametric one, so Yiji never goes through the lookup.
 */
export function registerVendorWebhooks(app: FastifyInstance, deps: VendorWebhookDeps): void {
  const { logger } = deps;

  const accept = async (
    vendorKey: string,
    vendor: WebhookVendor | null,
    body: unknown,
  ): Promise<string> => {
    const event = (body as { type?: string } | undefined)?.type ?? 'unknown';
    logger.info({ event, vendorKey }, 'webhook accepted');
    if (deps.onEvent) {
      try {
        await deps.onEvent({ vendorKey, vendor, event, body });
      } catch (err) {
        logger.warn({ err, vendorKey, event }, 'webhook processing failed');
      }
    }
    return event;
  };

  // Inbound webhook receiver (Yiji platform events). Rejects anything
  // without a valid HMAC signature + fresh timestamp. Disabled (503) until a
  // secret is configured, so it is never an unauthenticated open endpoint.
  app.post('/webhooks/yiji', async (req, reply) => {
    if (!deps.yijiWebhookSecret) {
      return reply.code(503).send({ status: 'webhooks-not-configured' });
    }
    const result = verifyWebhookSignature({
      secret: deps.yijiWebhookSecret,
      rawBody: rawBodyOf(req),
      signature: req.headers['x-yiji-signature'] as string | undefined,
      timestamp: req.headers['x-yiji-timestamp'] as string | undefined,
      toleranceSec: deps.toleranceSec,
    });
    if (!result.valid) {
      logger.warn({ reason: result.reason }, 'webhook signature rejected');
      return reply.code(401).send({ status: 'invalid-signature' });
    }
    // Signature verified. Downstream processing (fan-out / enqueue) is wired by
    // the consuming pipeline; we acknowledge receipt here.
    const event = await accept(YIJI_VENDOR_KEY, null, req.body);
    return reply.code(202).send({ status: 'accepted', event });
  });

  app.post<{ Params: { vendorKey: string } }>('/webhooks/:vendorKey', async (req, reply) => {
    const key = req.params.vendorKey;
    if (!VENDOR_KEY_PATTERN.test(key)) return reply.code(404).send({ status: 'unknown-vendor' });
    let vendor: WebhookVendor | null;
    try {
      vendor = await deps.findVendorByKey(key);
    } catch (err) {
      logger.warn({ err, vendorKey: key }, 'webhook vendor lookup failed');
      return reply.code(503).send({ status: 'vendor-lookup-failed' });
    }
    if (!vendor) return reply.code(404).send({ status: 'unknown-vendor' });

    /* THIS vendor's secret or nothing — never Yiji's. */
    const secret = key === YIJI_VENDOR_KEY ? null : deps.secrets.webhookSecret(key);
    if (!secret) return reply.code(503).send({ status: 'webhooks-not-configured' });

    const result = verifyWebhookSignature({
      secret,
      rawBody: rawBodyOf(req),
      signature: req.headers['x-yiji-signature'] as string | undefined,
      timestamp: req.headers['x-yiji-timestamp'] as string | undefined,
      toleranceSec: deps.toleranceSec,
    });
    if (!result.valid) {
      logger.warn({ reason: result.reason, vendorKey: key }, 'webhook signature rejected');
      return reply.code(401).send({ status: 'invalid-signature' });
    }
    const event = await accept(key, vendor, req.body);
    return reply.code(202).send({ status: 'accepted', event });
  });
}
