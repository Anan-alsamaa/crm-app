/**
 * WHICH VENDOR THE QR PAGE OPENS A CHAT FOR (MV-3, EMA-72).
 *
 * One page serves every vendor, so the vendor comes from the LINK: a printed
 * QR code for vendor B carries `?vendor=<B's platform id>`. A personal link
 * (`?c=<code>`) needs neither — the gateway reads the vendor off the link row.
 *
 * The build-time `VITE_WALK_IN_VENDOR_ID` (default `1`, Yiji) stays the
 * FALLBACK, so every QR code already printed — none of which has the
 * parameter — opens exactly the chat it opens today.
 *
 * Nothing here is trusted: the gateway refuses an unknown or inactive vendor,
 * and signs the session with THAT vendor's secret.
 */
const VENDOR_PARAM = /^[A-Za-z0-9_-]{1,64}$/;

export function walkInVendorId(search: string, buildTime: string | undefined): string {
  const fromUrl = new URLSearchParams(search ?? '').get('vendor')?.trim() ?? '';
  if (VENDOR_PARAM.test(fromUrl)) return fromUrl;
  return buildTime?.trim() || '1';
}
