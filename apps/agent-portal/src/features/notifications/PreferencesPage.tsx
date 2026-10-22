import { Children, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellIcon,
  Button,
  ClockIcon,
  cn,
  InboxIcon,
  SelectMenu,
  SettingsIcon,
  SoundOffIcon,
  SoundOnIcon,
  Spinner,
  TicketIcon,
  toast,
  UsersIcon,
} from '@yiji/ui';
import type { JSX, ReactNode } from 'react';
import { isSoundMuted, playMessageBeep, setSoundMuted } from '../../lib/sound.js';
import {
  CHANNELS,
  resolvePreferences,
  useNotificationPreferences,
  useOrgNotificationDefaults,
  useUpdateNotificationPreferences,
  useUpdateOrgNotificationDefaults,
} from './api.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * The administrator's "leave this to the agent" option.
 *
 * A policy is a map of the types the organisation dictates; a type simply
 * ABSENT from it is one each agent still controls. The select needs a value to
 * represent that absence, and it must not collide with a real channel — hence
 * a sentinel rather than an empty string, which a SelectMenu treats as
 * "nothing chosen" and would render blank.
 */
const ORG_UNSET = '__agent_decides__';

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

// Tones are tint+hue TOKEN pairs so both themes hold — the warning hue is
// deliberately absent from icon chips (it is a light token and fails contrast
// as chip ink on light).
const META: Record<string, RowMeta> = {
  sla_warning: {
    icon: ClockIcon,
    tone: 'bg-secondary text-muted-foreground',
    descriptionKey: 'preferences.desc.sla_warning',
    fallbackDescription: 'Heads-up before an SLA deadline arrives.',
  },
  sla_breach: {
    icon: ClockIcon,
    tone: 'bg-destructive-tint text-destructive',
    descriptionKey: 'preferences.desc.sla_breach',
    fallbackDescription: 'An SLA deadline was missed — act fast.',
  },
  assignment: {
    icon: UsersIcon,
    tone: 'bg-primary-tint text-primary',
    descriptionKey: 'preferences.desc.assignment',
    fallbackDescription: 'A conversation or ticket was assigned to you.',
  },
  mention: {
    icon: BellIcon,
    tone: 'bg-magenta/15 text-magenta',
    descriptionKey: 'preferences.desc.mention',
    fallbackDescription: 'A teammate @mentioned you in an internal note.',
  },
  ticket_update: {
    icon: TicketIcon,
    tone: 'bg-sky-tint text-sky',
    descriptionKey: 'preferences.desc.ticket_update',
    fallbackDescription: 'A ticket you own changed status or priority.',
  },
  reminder: {
    icon: ClockIcon,
    tone: 'bg-violet-tint text-violet',
    descriptionKey: 'preferences.desc.reminder',
    fallbackDescription: 'Scheduled reminders for follow-ups.',
  },
  escalation: {
    icon: InboxIcon,
    tone: 'bg-destructive-tint text-destructive',
    descriptionKey: 'preferences.desc.escalation',
    fallbackDescription: 'Something was escalated to you for review.',
  },
  automation: {
    icon: SettingsIcon,
    tone: 'bg-primary-tint text-primary',
    descriptionKey: 'preferences.desc.automation',
    fallbackDescription: 'An automation rule ran on your behalf.',
  },
};

export function PreferencesPage() {
  const { t } = useTranslation();
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const { can } = useAuth();
  const org = useOrgNotificationDefaults();
  const updateOrg = useUpdateOrgNotificationDefaults();

  /*
   * ONE PAGE, TWO THINGS IT CAN EDIT (owner, 2026-09-16).
   *
   * An administrator sets the organisation's notification policy here, on the
   * same page and with the same controls everybody else uses to set their own.
   * A separate admin screen would have meant two layouts to keep in step and
   * would hide the policy from the page it governs.
   *
   * `manage_notification_defaults` (owner, 2026-10-06), which was
   * `admin_access` and still defaults to the owner alone. This writes a
   * setting that reaches every user; the Directus permission on `app_settings`
   * is the real gate — this only decides whether the control is offered.
   */
  const isAdmin = can('manage_notification_defaults');
  const [scope, setScope] = useState<'mine' | 'everyone'>('mine');
  const editingOrg = isAdmin && scope === 'everyone';

  const [draft, setDraft] = useState<Record<string, string>>({});
  // New-message sound is a per-browser setting (localStorage), not a server
  // preference — so it applies instantly and doesn't ride the Save button.
  const [soundOn, setSoundOn] = useState(!isSoundMuted());
  const setSound = (on: boolean) => {
    setSoundMuted(!on);
    setSoundOn(on);
    if (on) playMessageBeep();
  };

  /*
   * The draft follows whichever thing is being edited.
   *
   * "Mine" shows the EFFECTIVE setting — what this person will actually
   * receive, policy applied — rather than the raw stored row. Showing the raw
   * row would tell an agent they had chosen `none` for something the
   * organisation has since made mandatory, which is a lie about what will
   * happen to them.
   */
  useEffect(() => {
    if (editingOrg) {
      setDraft(org.data ?? {});
      return;
    }
    if (prefs.data) setDraft(resolvePreferences(prefs.data, org.data));
  }, [editingOrg, prefs.data, org.data]);

  const loading = prefs.isLoading || !prefs.data || (isAdmin && org.isLoading);
  /** Is this type dictated by the organisation, and so not the agent's to set? */
  const lockedByPolicy = (type: string) => org.data?.[type] != null;

  const save = async () => {
    try {
      if (editingOrg) {
        /* Only the types the administrator actually dictates are stored. A row
           left on "Agent decides" is ABSENT from the policy, which is what
           lets each agent's own choice govern that type — writing a value for
           everything would seize the whole page from everybody at once. */
        const policy: Record<string, string> = {};
        for (const [type, value] of Object.entries(draft)) {
          if (value && value !== ORG_UNSET) policy[type] = value;
        }
        await updateOrg.mutateAsync(policy);
      } else {
        await update.mutateAsync(draft);
      }
      toast.success(t('preferences.saved'));
    } catch {
      toast.error(t('preferences.error'));
    }
  };

  /*
   * A SETTINGS PAGE THAT USES THE PAGE (owner, 2026-10-22: it "looks very bad -
   * uses half the page").
   *
   * It was one 5xl column of cards-inside-cards, so the right half of a desk
   * monitor was empty. Now: the title block across the page with the actions on
   * the far side; then each group as a band - its name and purpose on the
   * start edge, its settings in a card of ROWS on the end (what it is and why on
   * the start of the row, the control at its end), the rows two abreast on a
   * very wide screen. Same controls, same draft, same Save; only the arrangement
   * moved.
   */
  /* One segmented control, pill-shaped, the same for scope and for sound. */
  const segment = (active: boolean) =>
    cn(
      'inline-flex h-8 items-center rounded-full px-3.5 text-xs font-semibold transition-[background-color,color,box-shadow] duration-fast ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      active
        ? 'bg-card text-foreground shadow-[0_2px_8px_-4px_oklch(var(--shadow-color)/0.5)]'
        : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden pb-10">
      <header className="agent-gutter flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5 pt-5">
        <div className="min-w-0">
          <h1 className="text-foreground">{t('preferences.title')}</h1>
          <p className="mt-2 max-w-[46rem] text-sm leading-relaxed text-muted-foreground">
            {t('preferences.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {/*
            WHOSE SETTINGS AM I EDITING? Only an administrator sees this, and it
            is deliberately explicit rather than a mode the page slips into: the
            two halves look identical, so without a visible switch it would be
            possible to change the whole organisation believing you had changed
            your own notifications.
          */}
          {isAdmin && (
            <div
              role="group"
              aria-label={t('preferences.scope', { defaultValue: 'Editing' })}
              className="inline-flex shrink-0 items-center rounded-full bg-secondary/80 p-0.5 ring-1 ring-inset ring-foreground/[0.06]"
            >
              {(['mine', 'everyone'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => setScope(s)}
                  className={segment(scope === s)}
                >
                  {s === 'mine'
                    ? t('preferences.scopeMine', { defaultValue: 'My notifications' })
                    : t('preferences.scopeEveryone', { defaultValue: 'Everyone' })}
                </button>
              ))}
            </div>
          )}
          <Button
            type="button"
            onClick={() => void save()}
            loading={update.isPending}
            disabled={loading}
          >
            {t('actions.save', { ns: 'common' })}
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Spinner />
        </div>
      ) : (
        <div className="agent-gutter">
          <div className="min-w-0 space-y-5">
            {/* New-message sound - a per-browser setting, applied at once. */}
            <SettingsCard
              id="pref-sound"
              title={t('preferences.group.sound', { defaultValue: 'Sound' })}
              hint={t('sound.prefHint')}
            >
              <SettingRow
                icon={
                  <span
                    aria-hidden
                    className={cn(
                      'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors',
                      soundOn
                        ? 'bg-primary-tint text-primary'
                        : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {soundOn ? <SoundOnIcon size={18} /> : <SoundOffIcon size={18} />}
                  </span>
                }
                title={t('sound.prefTitle')}
                description={soundOn ? t('sound.statusOn') : t('sound.statusMuted')}
                control={
                  <div
                    role="group"
                    aria-label={t('sound.prefTitle')}
                    className="inline-flex shrink-0 items-center rounded-full bg-secondary/80 p-0.5 ring-1 ring-inset ring-foreground/[0.06]"
                  >
                    <button
                      type="button"
                      aria-pressed={soundOn}
                      onClick={() => setSound(true)}
                      className={segment(soundOn)}
                    >
                      {t('sound.on')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={!soundOn}
                      onClick={() => setSound(false)}
                      className={segment(!soundOn)}
                    >
                      {t('sound.off')}
                    </button>
                  </div>
                }
              />
            </SettingsCard>

            {GROUPS.map((g) => (
              <SettingsCard
                key={g.key}
                id={`pref-${g.key}`}
                title={t(g.titleKey, { defaultValue: g.titleFallback })}
                hint={t(g.descriptionKey, { defaultValue: g.descriptionFallback })}
              >
                {g.types.map((type) => {
                  const meta = META[type];
                  const Icon = meta?.icon;
                  const muted = draft[type] === 'none';
                  return (
                    <SettingRow
                      key={type}
                      icon={
                        Icon && (
                          <span
                            aria-hidden
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors duration-fast ease-out',
                              muted ? 'bg-secondary text-muted-foreground' : meta?.tone,
                            )}
                          >
                            <Icon size={18} />
                          </span>
                        )
                      }
                      title={t(`notifications.type.${type}`, { defaultValue: type })}
                      description={t(meta?.descriptionKey ?? '', {
                        defaultValue: meta?.fallbackDescription ?? '',
                      })}
                      note={
                        !editingOrg && lockedByPolicy(type)
                          ? t('preferences.setByAdmin', {
                              defaultValue: 'Set for everyone by an administrator',
                            })
                          : undefined
                      }
                      control={
                        /* Dropdown rather than a toggle: this is a four-way
                           choice (in-app / email / both / none), not on-off. */
                        <SelectMenu
                          size="sm"
                          className="w-36 shrink-0"
                          value={draft[type] ?? (editingOrg ? ORG_UNSET : 'both')}
                          onChange={(v: string) => setDraft((d) => ({ ...d, [type]: v }))}
                          aria-label={type}
                          /* Set by the organisation: say so and lock it, rather
                             than letting an agent pick something that would be
                             overruled the moment it was saved. */
                          disabled={!editingOrg && lockedByPolicy(type)}
                          options={[
                            /* Editing the POLICY gets one extra choice: leave
                               this type to each agent. It is the default, and
                               it is what absence from the policy means. */
                            ...(editingOrg
                              ? [
                                  {
                                    value: ORG_UNSET,
                                    label: t('preferences.agentDecides', {
                                      defaultValue: 'Agent decides',
                                    }),
                                  },
                                ]
                              : []),
                            ...CHANNELS.map((c) => ({
                              value: c,
                              label: t(`preferences.channels.${c}`, { defaultValue: c }),
                            })),
                          ]}
                        />
                      }
                    />
                  );
                })}
              </SettingsCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A group of settings as a band: the group's name and purpose on the start
 * edge, its rows in a card on the end. Stacks on a narrow screen.
 */
function SettingsCard({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid items-start gap-x-8 gap-y-3 border-t border-foreground/[0.07] pt-5 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]"
    >
      <div className="lg:pt-4">
        <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {hint && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <ul
        className={cn(
          'grid rounded-2xl bg-card px-6',
          Children.count(children) > 1 && '2xl:grid-cols-2 2xl:gap-x-10',
        )}
      >
        {children}
      </ul>
    </section>
  );
}

/** One setting: what it is and why on the start, its control on the end. */
function SettingRow({
  icon,
  title,
  description,
  note,
  control,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  note?: string;
  control: ReactNode;
}) {
  return (
    /* The hairline sits ABOVE each row after the first in its column, so a
       two-up card has no stray line over its top row. */
    <li className="flex min-h-[4.75rem] flex-wrap items-center gap-x-4 gap-y-3 border-t border-foreground/[0.06] py-4 first:border-t-0 2xl:[&:nth-child(2)]:border-t-0">
      {icon}
      <div className="min-w-[12rem] flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description && (
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
        {note && <p className="mt-1 text-xs font-semibold text-foreground/70">{note}</p>}
      </div>
      <div className="ms-auto flex shrink-0 items-center">{control}</div>
    </li>
  );
}
