import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { whatsappNumber } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * The WhatsApp reply, done the way the ops portal proved out.
 *
 * WhatsApp itself never records WHICH employee answered a customer. Launching
 * the reply from the ticket closes that gap without any WhatsApp integration:
 * the click opens `wa.me` with the message pre-drafted, and the caller stamps a
 * `contacted` ticket event naming the agent — so every customer contact has an
 * author on record, which is exactly the thing wa.me alone cannot give.
 *
 * No Cloud API, deliberately. Reading messages automatically needs a verified
 * Meta business, an approved app and an always-on public webhook — and the
 * unofficial automation routes breach WhatsApp's terms and risk the number.
 */

/**
 * `0551234567` or `551234567` (Excel eats the leading zero) → `966551234567`.
 *
 * Re-exported rather than reimplemented: the rule now lives in
 * @yiji/shared-types beside `normalizePhone`, because the customer widget needs
 * the identical conversion for its offline WhatsApp link and two copies of a
 * phone rule is how one of them quietly stops matching the other.
 */
export const saudiWaNumber = whatsappNumber;

export const DEFAULT_WA_TEMPLATE =
  'مرحباً عزيزي، معك خدمة عملاء تطبيق يجي، تواصلنا بخصوص شكواكم على الطلب رقم {order}';

/**
 * Fill `{order}`, `{name}`, `{brand}` and `{restaurant}` from the ticket. A
 * placeholder with nothing behind it collapses to blank rather than shipping
 * `{order}` literally to a customer.
 */
export function fillWaTemplate(
  template: string,
  vars: {
    order?: string | null;
    name?: string | null;
    brand?: string | null;
    restaurant?: string | null;
  },
): string {
  return template
    .replaceAll('{order}', vars.order ?? '')
    .replaceAll('{name}', vars.name ?? '')
    .replaceAll('{brand}', vars.brand ?? '')
    .replaceAll('{restaurant}', vars.restaurant ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The editable template, from app_settings; ships with the Arabic default. */
export function useWaTemplate() {
  return useQuery({
    queryKey: ['app-setting', 'whatsapp_template'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string> => {
      try {
        const rows = (await directus.request(
          readItems(
            'app_settings' as never,
            {
              filter: { key: { _eq: 'whatsapp_template' } },
              limit: 1,
              fields: ['value'],
            } as never,
          ),
        )) as unknown as Array<{ value: string | null }>;
        return rows[0]?.value?.trim() || DEFAULT_WA_TEMPLATE;
      } catch {
        return DEFAULT_WA_TEMPLATE;
      }
    },
  });
}

/** The URL, or null when the ticket has no usable Saudi mobile. */
export function waUrl(phone: string | null | undefined, message: string): string | null {
  const number = saudiWaNumber(phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
