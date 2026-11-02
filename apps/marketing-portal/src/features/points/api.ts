import { useQuery } from '@tanstack/react-query';
import { resolveUrl } from '@yiji/shared-config';
import { auth } from '../../lib/directus.js';

/*
 * Points are read through the CRM's gateway, never from Yiji directly: the
 * browser holds no Yiji credential, and the gateway checks this person may use
 * the Marketing portal before it asks Yiji anything.
 */
const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);

/** What went wrong, in words, for the page to show. */
export class PointsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = await auth.getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GATEWAY_URL}${path}${qs ? `?${qs}` : ''}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new PointsError(body.error ?? `http_${res.status}`);
  return body.data as T;
}

export interface PointsEntry {
  id?: number;
  points?: number;
  earnedPointBy?: number;
  earnByOrderId?: number | null;
  expirationDate?: string | null;
  creationTime?: string | null;
  status?: number;
}

export interface CustomerPoints {
  found: boolean;
  reason?: 'bad_phone' | 'none' | 'several';
  customer?: { id: string; phone: string; name: string | null };
  points?: PointsEntry[] | { items?: PointsEntry[] } | null;
}

/** A customer's points, looked up only when a phone is given (one call per search). */
export function useCustomerPoints(phone: string | null) {
  return useQuery({
    queryKey: ['marketing-points-customer', phone],
    enabled: !!phone,
    staleTime: 60_000,
    refetchInterval: false,
    retry: false,
    queryFn: () => get<CustomerPoints>('/commerce/marketing/points/customer', { phone: phone! }),
  });
}

export interface PointsRule {
  id: number;
  pointsRuleType?: number;
  fixedPoints?: number;
  pourcentagePoints?: number;
  unitPointEquivalent?: number;
  status?: number;
}

export function usePointsRules() {
  return useQuery({
    queryKey: ['marketing-points-rules'],
    staleTime: 300_000,
    refetchInterval: false,
    retry: false,
    queryFn: () =>
      get<{ fixed: PointsRule[] | null; percentage: PointsRule[] | null }>(
        '/commerce/marketing/points/rules',
      ),
  });
}

/** Yiji's points report for a window (at most 31 days), asked for on demand. */
export function usePointsReport(
  q: { type: 'issued' | 'consumed'; from: string; to: string } | null,
) {
  return useQuery({
    queryKey: ['marketing-points-report', q],
    enabled: !!q,
    staleTime: 300_000,
    refetchInterval: false,
    retry: false,
    queryFn: () =>
      get<unknown>('/commerce/marketing/points/report', {
        type: q!.type,
        from: q!.from,
        to: q!.to,
      }),
  });
}

/** A list from any of Yiji's shapes: a bare array, `{items}`, `{data}`. */
export function asList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  const o = v as { items?: unknown; data?: unknown } | null;
  if (Array.isArray(o?.items)) return o!.items as T[];
  if (Array.isArray(o?.data)) return o!.data as T[];
  return [];
}
