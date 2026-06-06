import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellIcon,
  Button,
  ClockIcon,
  InboxIcon,
  Select,
  SettingsIcon,
  Spinner,
  TicketIcon,
  toast,
  Toolbar,
  ToolbarSpacer,
  UsersIcon,
} from '@yiji/ui';
import type { JSX } from 'react';
import { CHANNELS, useNotificationPreferences, useUpdateNotificationPreferences } from './api.js';

interface RowMeta {
  icon: (props: { size?: number; className?: string }) => JSX.Element;
  tone: string;
  descriptionKey: string;
  fallbackDescription: string;
}

interface PrefGroup {
  key: string;
  titleKey: string;
  titleFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  types: string[];
}

const GROUPS: PrefGroup[] = [
  {
    key: 'sla',
    titleKey: 'preferences.group.sla',
    titleFallback: 'SLA',
    descriptionKey: 'preferences.group.slaHint',
    descriptionFallback: 'Stay ahead of response and resolution deadlines.',
    types: ['sla_warning', 'sla_breach'],
  },
  {
    key: 'tickets',
    titleKey: 'preferences.group.tickets',
    titleFallback: 'Tickets',
    descriptionKey: 'preferences.group.ticketsHint',
    descriptionFallback: 'Work assigned to you and updates on tickets you own.',
    types: ['assignment', 'ticket_update', 'escalation'],
  },
  {
    key: 'mentions',
    titleKey: 'preferences.group.mentions',
    titleFallback: 'Mentions & reminders',
    descriptionKey: 'preferences.group.mentionsHint',
    descriptionFallback: 'When teammates loop you in or you schedule a follow-up.',
    types: ['mention', 'reminder'],
  },
  {
    key: 'automation',
    titleKey: 'preferences.group.automation',
    titleFallback: 'Automation',
    descriptionKey: 'preferences.group.automationHint',
    descriptionFallback: 'Automated actions taken on your behalf.',
    types: ['automation'],
  },
];

const META: Record<string, RowMeta> = {
  sla_warning: {
    icon: ClockIcon,
    tone: 'bg-warning/15 text-warning-foreground',
    descriptionKey: 'preferences.desc.sla_warning',
    fallbackDescription: 'Heads-up before an SLA deadline arrives.',
  },
  sla_breach: {
    icon: ClockIcon,
    tone: 'bg-destructive/15 text-destructive',
    descriptionKey: 'preferences.desc.sla_breach',
    fallbackDescription: 'An SLA deadline was missed — act fast.',
  },
  assignment: {
    icon: UsersIcon,
    tone: 'bg-primary-subtle text-primary',
    descriptionKey: 'preferences.desc.assignment',
    fallbackDescription: 'A conversation or ticket was assigned to you.',
  },
  mention: {
    icon: BellIcon,
    tone: 'bg-[oklch(0.93_0.07_0)] text-[oklch(0.50_0.20_0)]',
    descriptionKey: 'preferences.desc.mention',
    fallbackDescription: 'A teammate @mentioned you in an internal note.',
  },
  ticket_update: {
    icon: TicketIcon,
    tone: 'bg-[oklch(0.94_0.05_240)] text-[oklch(0.48_0.18_245)]',
    descriptionKey: 'preferences.desc.ticket_update',
    fallbackDescription: 'A ticket you own changed status or priority.',
  },
  reminder: {
    icon: ClockIcon,
    tone: 'bg-[oklch(0.94_0.06_300)] text-[oklch(0.48_0.20_295)]',
    descriptionKey: 'preferences.desc.reminder',
    fallbackDescription: 'Scheduled reminders for follow-ups.',
  },
  escalation: {
    icon: InboxIcon,
    tone: 'bg-[oklch(0.94_0.07_55)] text-[oklch(0.52_0.17_45)]',
    descriptionKey: 'preferences.desc.escalation',
    fallbackDescription: 'Something was escalated to you for review.',
  },
  automation: {
    icon: SettingsIcon,
    tone: 'bg-[oklch(0.94_0.05_200)] text-[oklch(0.46_0.13_205)]',
    descriptionKey: 'preferences.desc.automation',
    fallbackDescription: 'An automation rule ran on your behalf.',
  },
};

export function PreferencesPage() {
  const { t } = useTranslation();
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);

  const loading = prefs.isLoading || !prefs.data;

  const save = async () => {
    try {
      await update.mutateAsync(draft);
      toast.success(t('preferences.saved'));
    } catch {
      toast.error(t('preferences.error'));
    }
  };

  // The toolbar (title + Save) renders immediately; only the list body waits on
  // data — consistent with the other admin/agent pages and so the heading is
  // available right away.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('preferences.title')}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          <span className="opacity-50">·</span> {t('preferences.description')}
        </span>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          loading={update.isPending}
          disabled={loading}
        >
          {t('actions.save', { ns: 'common' })}
        </Button>
      </Toolbar>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl flex-1 overflow-auto px-6 py-8 space-y-6 sm:px-10">
          {GROUPS.map((g) => (
            <section key={g.key} className="space-y-3">
              <div className="space-y-1 px-1">
                <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t(g.titleKey, { defaultValue: g.titleFallback })}
                </h2>
                <p className="text-sm text-foreground/80">
                  {t(g.descriptionKey, { defaultValue: g.descriptionFallback })}
                </p>
              </div>
              <ul className="rounded-2xl bg-card/60 shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04] divide-y divide-border/40 px-5">
                {g.types.map((type) => {
                  const meta = META[type];
                  return (
                    <li
                      key={type}
                      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">
                          {t(`notifications.type.${type}`, { defaultValue: type })}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t(meta?.descriptionKey ?? '', {
                            defaultValue: meta?.fallbackDescription ?? '',
                          })}
                        </p>
                      </div>
                      <Select
                        className="h-8 w-full sm:w-44 text-xs"
                        value={draft[type] ?? 'both'}
                        onChange={(e) => setDraft((d) => ({ ...d, [type]: e.target.value }))}
                        aria-label={type}
                      >
                        {CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {t(`preferences.channels.${c}`, { defaultValue: c })}
                          </option>
                        ))}
                      </Select>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
