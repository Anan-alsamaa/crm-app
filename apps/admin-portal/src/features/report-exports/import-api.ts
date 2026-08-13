/**
 * Complaints bulk import — MOVED here from the agent portal at the owner's
 * request: importing history is an operations-manager job, and the agent
 * portal no longer offers it. Same pipeline, same aliases, same outcomes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createItem, createItems, readItems } from '@directus/sdk';
import { buildStoreIndex, matchStore, type StoreRecord } from '@yiji/shared-types';
import {
  parseTicketsCsv,
  ticketPayloadFromCsvRow,
  toComplaintDate,
  type ParseTicketsResult,
} from '@yiji/reports';
import { directus } from '../../lib/directus.js';

/**
 * Import tickets from a CSV in the operations report format.
 *
 * The rule is the plain one: each column goes to the field it names. What
 * takes the work is everything the sheet does NOT carry as an id — the branch
 * is a name, the customer is a phone number, the agent is a first name — so
 * each has to be resolved against what is already in the system rather than
 * duplicated.
 *
 * Rows are INSERTED. Unlike the stores import there is no natural key for a
 * ticket, so re-uploading the same file adds the rows again; the count in the
 * result is what landed, so a double import is at least visible immediately.
 */

export interface TicketImportOutcome {
  imported: number;
  /** Rows the file contained but we could not use, with the reason. */
  skipped: Array<{ line: number; reason: string }>;
  /** Header columns we could not place, so a typo in the sheet is visible. */
  unmappedHeaders: string[];
  /** Imported rows whose branch did not resolve to a store. */
  unmappedStores: number;
  /** Customers created because no contact had that number yet. */
  contactsCreated: number;
}

interface RawContact {
  id: string;
  phone: string | null;
}
interface RawStoreRow {
  id: string;
  code: string | null;
  name: string;
  city: string | null;
  area_manager: string | null;
  chain_manager: string | null;
  yiji_restaurant_id: string | null;
  brand: { code: string; name: string; yiji_brand_name: string | null } | null;
}

const digits = (v: string): string => v.replace(/\D+/g, '');

/** Chunked because Directus rejects very large payloads. */
const CHUNK = 50;

export function useImportTickets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | ParseTicketsResult): Promise<TicketImportOutcome> => {
      // A string is CSV text; anything else already went through the shared
      // parser (the .xlsx path) — same rows, same aliases, same skip reasons.
      const parsed = typeof input === 'string' ? parseTicketsCsv(input) : input;
      const outcome: TicketImportOutcome = {
        imported: 0,
        skipped: [...parsed.skipped],
        unmappedHeaders: parsed.unmappedHeaders,
        unmappedStores: 0,
        contactsCreated: 0,
      };
      if (parsed.rows.length === 0) return outcome;

      const [stores, contacts, vendors, users] = await Promise.all([
        directus.request(
          readItems(
            'stores' as never,
            {
              limit: -1,
              fields: [
                'id',
                'code',
                'name',
                'city',
                'area_manager',
                'chain_manager',
                'yiji_restaurant_id',
                'brand.code',
                'brand.name',
                'brand.yiji_brand_name',
              ],
            } as never,
          ),
        ) as Promise<RawStoreRow[]>,
        directus.request(
          readItems('contacts' as never, { limit: -1, fields: ['id', 'phone'] } as never),
        ) as Promise<RawContact[]>,
        directus.request(
          readItems('vendors' as never, { limit: 1, fields: ['id'] } as never),
        ) as Promise<Array<{ id: string }>>,
        directus.request(
          readItems(
            'directus_users' as never,
            {
              limit: -1,
              fields: ['id', 'first_name', 'last_name'],
            } as never,
          ),
        ) as Promise<Array<{ id: string; first_name: string | null; last_name: string | null }>>,
      ]);

      const vendorId = vendors[0]?.id ?? null;
      const index = buildStoreIndex(
        stores.map(
          (s): StoreRecord => ({
            id: s.id,
            code: s.code,
            name: s.name,
            city: s.city,
            areaManager: s.area_manager,
            chainManager: s.chain_manager,
            brandCode: s.brand?.code ?? null,
            brandName: s.brand?.name ?? null,
            brandYijiName: s.brand?.yiji_brand_name ?? null,
            yijiRestaurantId: s.yiji_restaurant_id,
          }),
        ),
      );

      // Phone → contact. Compared on digits only: the same number is written
      // "+966 50…", "0550…" and "966550…" depending on who typed it, and an
      // exact compare would create a second contact for a customer we have.
      const contactByPhone = new Map<string, string>();
      for (const c of contacts) {
        const d = digits(c.phone ?? '');
        if (d && !contactByPhone.has(d)) contactByPhone.set(d, c.id);
      }
      // Agent first names, as the sheet writes them.
      const userByName = new Map<string, string>();
      for (const u of users) {
        for (const n of [u.first_name, [u.first_name, u.last_name].filter(Boolean).join(' ')]) {
          const key = (n ?? '').trim().toLowerCase();
          if (key && !userByName.has(key)) userByName.set(key, u.id);
        }
      }

      const capturedAt = new Date().toISOString();
      const payloads: Record<string, unknown>[] = [];

      for (const [i, row] of parsed.rows.entries()) {
        const line = i + 2;
        const when = toComplaintDate(row.date, row.time);

        // Resolve the customer, creating one only when the number is new.
        let contactId: string | null = null;
        const phone = (row.customerMobile ?? '').trim();
        const phoneKey = digits(phone);
        if (phoneKey) {
          contactId = contactByPhone.get(phoneKey) ?? null;
          if (!contactId && vendorId) {
            try {
              const created = (await directus.request(
                createItem('contacts' as never, { phone, vendor: vendorId } as never),
              )) as { id: string };
              contactId = created.id;
              contactByPhone.set(phoneKey, created.id);
              outcome.contactsCreated += 1;
            } catch {
              // A contact we could not create must not lose the complaint —
              // the ticket still imports, just without the customer link.
            }
          }
        }

        const branch = (row.restaurantName ?? '').trim();
        const match = matchStore(index, { restaurantName: branch, brandName: row.brand });
        if (branch && !match.store) outcome.unmappedStores += 1;

        const agentKey = (row.agent ?? '').trim().toLowerCase();
        payloads.push(
          ticketPayloadFromCsvRow(row, {
            store: match,
            contactId,
            vendorId,
            agentId: userByName.get(agentKey) ?? null,
            complaintDate: when,
            capturedAt,
          }),
        );
        if (!when && row.date) {
          outcome.skipped.push({
            line,
            reason: `unreadable date "${row.date}" — imported undated`,
          });
        }
      }

      for (let i = 0; i < payloads.length; i += CHUNK) {
        const slice = payloads.slice(i, i + CHUNK);
        await directus.request(createItems('tickets' as never, slice as never));
        outcome.imported += slice.length;
      }

      return outcome;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-complaints'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}
