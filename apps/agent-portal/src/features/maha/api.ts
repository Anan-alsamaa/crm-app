import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItem } from '@directus/sdk';
import { resolveUrl } from '@yiji/shared-config';
import { auth, directus } from '../../lib/directus.js';

/** Where the gateway's REST app lives — the same origin the socket uses. */
const GATEWAY_URL = resolveUrl(
  'SOCKET_URL',
  import.meta.env.VITE_SOCKET_URL,
  'http://localhost:8080',
);

/** Maha's state on one chat (owner, 2026-11-09). */
export interface MahaChatState {
  active: boolean;
  handoverAt: string | null;
  handoverReason: string | null;
  handoverSummary: string | null;
  agentJoinedAt: string | null;
}

export const mahaKey = (conversationId: string) => ['maha', conversationId] as const;

/**
 * Read on its own query: an environment without Maha's fields answers with an
 * error, and then there is simply no Maha on screen - nothing else breaks.
 * Refreshed by `conversation:changed` (ConversationView invalidates it).
 */
export function useMahaState(conversationId: string | null) {
  return useQuery({
    queryKey: mahaKey(conversationId ?? ''),
    enabled: !!conversationId,
    retry: false,
    queryFn: async (): Promise<MahaChatState | null> => {
      try {
        const r = (await directus.request(
          readItem('conversations', conversationId!, {
            fields: [
              'ai_active',
              'ai_handover_at',
              'ai_handover_reason',
              'ai_handover_summary',
              'ai_agent_joined_at',
            ],
          } as never),
        )) as {
          ai_active?: boolean | null;
          ai_handover_at?: string | null;
          ai_handover_reason?: string | null;
          ai_handover_summary?: string | null;
          ai_agent_joined_at?: string | null;
        } | null;
        if (!r) return null;
        return {
          active: r.ai_active === true,
          handoverAt: r.ai_handover_at ?? null,
          handoverReason: r.ai_handover_reason ?? null,
          handoverSummary: r.ai_handover_summary ?? null,
          agentJoinedAt: r.ai_agent_joined_at ?? null,
        };
      } catch {
        return null;
      }
    },
  });
}

/** The per-chat switch. Off = I take this chat; on = Maha continues. */
export function useSetMaha(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean) => {
      const token = await auth.getToken();
      const res = await fetch(`${GATEWAY_URL}/chat/maha`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify({ conversationId, on }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mahaKey(conversationId) });
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });
}
