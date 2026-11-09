import { useTranslation } from 'react-i18next';
import { Button, cn, SparkleIcon, toast } from '@yiji/ui';
import { mahaHandoverReasonLabel } from '@yiji/shared-types';
import { useMahaState, useSetMaha, type MahaChatState } from './api.js';

/**
 * MAHA'S SWITCH, in the chat header (owner, 2026-11-09). Shown only where
 * Maha exists (her fields are readable) and only once she has had a part in
 * this chat - on or handed over. Off = "I take this chat"; on = Maha answers
 * again.
 */
export function MahaToggle({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const state = useMahaState(conversationId).data;
  const set = useSetMaha(conversationId);
  if (!state || (!state.active && !state.handoverAt)) return null;
  const toggle = () =>
    set.mutate(!state.active, {
      onError: (e) =>
        toast.error(
          e.message === 'maha_off'
            ? t('maha.offForVendor', { defaultValue: 'Maha is switched off in the AI settings.' })
            : t('maha.switchFailed', { defaultValue: 'Could not switch Maha. Try again.' }),
        ),
    });
  return (
    <Button
      type="button"
      size="sm"
      variant={state.active ? 'default' : 'outline'}
      onClick={toggle}
      disabled={set.isPending}
      aria-pressed={state.active}
      title={
        state.active
          ? t('maha.turnOffHint', { defaultValue: 'Turn Maha off to reply yourself' })
          : t('maha.turnOnHint', { defaultValue: 'Let Maha answer again' })
      }
    >
      <SparkleIcon size={16} aria-hidden />
      {state.active
        ? t('maha.on', { defaultValue: 'Maha on' })
        : t('maha.off', { defaultValue: 'Maha off' })}
    </Button>
  );
}

/**
 * Above the message box: while Maha has the chat, why the box is locked and
 * how to take over; after her handover (until the agent has written), why she
 * handed over and her summary.
 */
export function MahaBanner({
  conversationId,
  state,
  className,
}: {
  conversationId: string;
  state: MahaChatState | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const set = useSetMaha(conversationId);
  if (!state) return null;
  if (state.active) {
    return (
      <div
        role="status"
        className={cn(
          'flex items-center justify-between gap-3 rounded-[1.25rem] bg-primary/[0.06] px-4 py-3 text-sm ring-1 ring-inset ring-primary/20',
          className,
        )}
      >
        <span className="flex items-center gap-2 text-foreground">
          <SparkleIcon size={16} className="text-primary" aria-hidden />
          {t('maha.handling', {
            defaultValue: 'Maha is handling this chat. Turn her off to reply.',
          })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={set.isPending}
          onClick={() => set.mutate(false)}
        >
          {t('maha.takeOver', { defaultValue: 'Turn off and reply' })}
        </Button>
      </div>
    );
  }
  if (!state.handoverAt || state.agentJoinedAt || state.handoverReason === 'agent_took_over') {
    return null;
  }
  return (
    <div
      role="note"
      className={cn(
        'rounded-[1.25rem] bg-warning/[0.08] px-4 py-3 text-sm ring-1 ring-inset ring-warning/25',
        className,
      )}
    >
      <p className="font-semibold text-foreground">
        {t('maha.handedOver', {
          defaultValue: 'Maha handed this chat over: {{reason}}',
          reason: mahaHandoverReasonLabel(state.handoverReason),
        })}
      </p>
      {state.handoverSummary && (
        <p dir="auto" className="mt-1 text-muted-foreground">
          {state.handoverSummary}
        </p>
      )}
    </div>
  );
}
