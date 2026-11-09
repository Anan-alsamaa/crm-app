import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { aggregate } from '@directus/sdk';
import { directus } from '../../lib/directus.js';
import { cn, FormField, Input } from '@yiji/ui';
import { chatAiMode, type AiFeatureConfig } from '@yiji/shared-types';

type Config = typeof AiFeatureConfig._type;
type Mode = 'off' | 'assist' | 'auto';

/**
 * MAHA, THE CHAT ASSISTANT (owner, 2026-11-09). One choice, three settings:
 *  - Off: as today. Assist: Maha drafts a reply for the agent. Auto: Maha
 *    answers customers and hands over when a person is needed.
 *  - The monthly budget (SAR, at the paid list price): at the budget new
 *    chats go straight to agents.
 *  - Her hours (Riyadh): the same time twice means all day.
 *  - Staging only: the scripted test AI instead of Gemini (free, repeatable).
 */
export function MahaSettings({
  draft,
  onChange,
  scriptedAvailable,
  spendSar,
}: {
  draft: Config;
  onChange: (next: Config) => void;
  scriptedAvailable: boolean;
  /** Maha's spend this month (SAR), from the AI gateway's usage. */
  spendSar?: number;
}) {
  const { t } = useTranslation();
  const mode = chatAiMode(draft);
  const modes: Array<{ value: Mode; label: string; hint: string }> = [
    {
      value: 'off',
      label: t('maha.mode.off', { defaultValue: 'Off' }),
      hint: t('maha.mode.offHint', { defaultValue: 'Agents answer every chat, as today.' }),
    },
    {
      value: 'assist',
      label: t('maha.mode.assist', { defaultValue: 'Assist' }),
      hint: t('maha.mode.assistHint', {
        defaultValue: 'Maha drafts a reply; the agent checks it and sends it.',
      }),
    },
    {
      value: 'auto',
      label: t('maha.mode.auto', { defaultValue: 'Auto' }),
      hint: t('maha.mode.autoHint', {
        defaultValue:
          'Maha answers customers herself and hands the chat to an agent when a person is needed.',
      }),
    },
  ];
  const set = (patch: Partial<Config>) => onChange({ ...draft, ...patch });

  return (
    <section className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
      <h2 className="text-sm font-semibold text-foreground">
        {t('maha.settingsTitle', { defaultValue: 'Maha, the chat assistant' })}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('maha.settingsHint', {
          defaultValue:
            'She answers only from the Knowledge base, never offers compensation, and hands over to the normal assignment rules.',
        })}
      </p>

      <MahaThisMonth spendSar={spendSar} />

      <div role="radiogroup" aria-label="Maha" className="mt-4 grid gap-2 sm:grid-cols-3">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            onClick={() => set({ chatAi: m.value, autoReply: m.value !== 'off' })}
            className={cn(
              'rounded-xl px-4 py-3 text-start ring-1 ring-inset transition-colors duration-fast',
              mode === m.value
                ? 'bg-primary-tint ring-primary/40'
                : 'bg-card ring-foreground/10 hover:bg-secondary',
            )}
          >
            <span className="block text-sm font-medium text-foreground">{m.label}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{m.hint}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <FormField
          label={t('maha.cap', { defaultValue: 'Monthly budget (SAR)' })}
          hint={t('maha.capHint', { defaultValue: '0 = no limit' })}
        >
          <Input
            type="number"
            min={0}
            value={String(draft.chatAiMonthlyCapSar)}
            onChange={(e) => set({ chatAiMonthlyCapSar: Math.max(0, Number(e.target.value) || 0) })}
          />
        </FormField>
        <FormField
          label={t('maha.from', { defaultValue: 'Works from' })}
          hint={t('maha.hoursHint', { defaultValue: 'Same time twice = all day' })}
        >
          <Input
            type="time"
            value={draft.chatAiFrom}
            onChange={(e) => set({ chatAiFrom: e.target.value })}
          />
        </FormField>
        <FormField label={t('maha.to', { defaultValue: 'Until' })}>
          <Input
            type="time"
            value={draft.chatAiTo}
            onChange={(e) => set({ chatAiTo: e.target.value })}
          />
        </FormField>
        <FormField label={t('maha.maxReplies', { defaultValue: 'Replies before handover' })}>
          <Input
            type="number"
            min={1}
            max={10}
            value={String(draft.autoReplyMaxTurns)}
            onChange={(e) =>
              set({ autoReplyMaxTurns: Math.min(10, Math.max(1, Number(e.target.value) || 3)) })
            }
          />
        </FormField>
      </div>

      {scriptedAvailable && (
        <label className="mt-4 flex items-start gap-3 rounded-xl bg-warning/[0.08] px-4 py-3 text-xs ring-1 ring-inset ring-warning/25">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.chatAiScripted}
            onChange={(e) => set({ chatAiScripted: e.target.checked })}
          />
          <span>
            <span className="block font-medium text-foreground">
              {t('maha.scripted', { defaultValue: 'Staging: use the scripted test AI' })}
            </span>
            {t('maha.scriptedHint', {
              defaultValue:
                'Free and repeatable, no Google calls. Type [[handover]], [[fail]], [[slow]], [[offerx]], [[claimx]], [[empty]] or [[garbage]] in a test message to drive each case.',
            })}
          </span>
        </label>
      )}
    </section>
  );
}

/**
 * MAHA THIS MONTH (owner, 2026-11-09): chats she took, resolved alone, handed
 * to people, and her spend. Counted with Directus aggregates (no rows pulled):
 * a session she took starts with her introduction; a handover leaves her
 * handover line; an agent switching her off leaves the reason on the chat.
 * Hidden when unreadable - a missing card beats a zero that reads as "none".
 */
export function MahaThisMonth({ spendSar }: { spendSar: number | undefined }) {
  const { t } = useTranslation();
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const q = useQuery({
    queryKey: ['maha-month', since],
    retry: false,
    queryFn: async () => {
      const count = async (collection: string, filter: Record<string, unknown>) => {
        const res = (await directus.request(
          aggregate(collection as never, { aggregate: { count: '*' }, query: { filter } } as never),
        )) as unknown as Array<{ count: string | number | null }>;
        return Number(res?.[0]?.count ?? 0) || 0;
      };
      const [taken, handedOver, takenOver] = await Promise.all([
        count('messages', { source: { _eq: 'maha_intro' }, date_created: { _gte: since } }),
        count('messages', { source: { _eq: 'maha_handover' }, date_created: { _gte: since } }),
        count('conversations', {
          ai_handover_reason: { _eq: 'agent_took_over' },
          ai_handover_at: { _gte: since },
        }),
      ]);
      return { taken, handedOver, takenOver, alone: Math.max(taken - handedOver - takenOver, 0) };
    },
  });
  if (q.isError || !q.data) return null;
  const d = q.data;
  const pct = d.taken ? Math.round((d.alone / d.taken) * 100) : 0;
  const cell = (label: string, value: string) => (
    <div className="rounded-xl bg-secondary/50 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {cell(t('maha.stats.taken', { defaultValue: 'Chats this month' }), String(d.taken))}
      {cell(t('maha.stats.alone', { defaultValue: 'Resolved by Maha' }), `${d.alone} (${pct}%)`)}
      {cell(t('maha.stats.handedOver', { defaultValue: 'Handed to agents' }), String(d.handedOver))}
      {cell(
        t('maha.stats.takenOver', { defaultValue: 'Agent turned her off' }),
        String(d.takenOver),
      )}
      {cell(
        t('maha.stats.spend', { defaultValue: 'Spend (SAR)' }),
        (spendSar ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),
      )}
    </div>
  );
}
