import { useTranslation } from 'react-i18next';
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
}: {
  draft: Config;
  onChange: (next: Config) => void;
  scriptedAvailable: boolean;
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
