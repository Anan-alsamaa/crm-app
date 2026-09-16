import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellIcon,
  Button,
  ClockIcon,
  cn,
  InboxIcon,
  SectionCard,
  SelectMenu,
  SettingsIcon,
  SoundOffIcon,
  SoundOnIcon,
  Spinner,
  TicketIcon,
  toast,
  Toolbar,
  ToolbarSpacer,
  UsersIcon,
} from '@yiji/ui';
import type { JSX } from 'react';
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
  const { user: me } = useAuth();
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
   * `admin_access` rather than a role name: this writes a setting that reaches
   * every user, so it is fenced by the property Directus itself enforces. The
   * Directus permission on `app_settings` is the real gate — this only decides
   * whether the control is offered.
   */
  const isAdmin = me?.admin_access === true;
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
            className="inline-flex shrink-0 rounded-lg bg-secondary p-0.5 text-xs"
          >
            {(['mine', 'everyone'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium transition-colors duration-fast ease-out',
                  scope === s
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
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
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-4xl space-y-5 px-5 py-8 sm:px-8">
            {/* New-message sound — a per-browser toggle, kept visually distinct
              from the server-saved channel rows below. Same SectionCard surface
              as the groups so the page reads as one board. */}
            <SectionCard
              title={t('preferences.group.sound', { defaultValue: 'Sound' })}
              hint={t('sound.prefHint')}
            >
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className={cn(
                      'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors',
                      soundOn
                        ? 'bg-primary-tint text-primary'
                        : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {soundOn ? <SoundOnIcon size={18} /> : <SoundOffIcon size={18} />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {t('sound.prefTitle')}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {soundOn ? t('sound.statusOn') : t('sound.statusMuted')}
                    </p>
                  </div>
                </div>
                <div
                  role="group"
                  aria-label={t('sound.prefTitle')}
                  className="inline-flex shrink-0 rounded-lg bg-secondary p-0.5 text-xs"
                >
                  <button
                    type="button"
                    aria-pressed={soundOn}
                    onClick={() => setSound(true)}
                    className={cn(
                      'rounded-md px-3.5 py-1.5 font-medium transition-colors duration-fast ease-out',
                      soundOn
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('sound.on')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={!soundOn}
                    onClick={() => setSound(false)}
                    className={cn(
                      'rounded-md px-3.5 py-1.5 font-medium transition-colors duration-fast ease-out',
                      !soundOn
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('sound.off')}
                  </button>
                </div>
              </div>
            </SectionCard>

            {GROUPS.map((g) => (
              <SectionCard
                key={g.key}
                title={t(g.titleKey, { defaultValue: g.titleFallback })}
                hint={t(g.descriptionKey, { defaultValue: g.descriptionFallback })}
              >
                {/* Two-column card grid, matching the AI assistance page: each
                  notification type is its OWN card rather than a row in a shared
                  list. A divided list reads as settings-you-scan; discrete cards
                  read as features-you-choose, which is what these are. */}
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {g.types.map((type, i) => {
                    const meta = META[type];
                    const Icon = meta?.icon;
                    const muted = draft[type] === 'none';
                    // An odd count strands the last card beside a dead cell at
                    // two-up; letting it span keeps the group a solid block.
                    const spans = i === g.types.length - 1 && g.types.length % 2 === 1;
                    return (
                      <li
                        key={type}
                        className={cn(
                          'group flex items-start gap-3.5 rounded-2xl px-4 py-4 transition-colors duration-fast ease-out',
                          spans && 'sm:col-span-2',
                          // Same active/inactive treatment as the AI assistance
                          // cards: a live setting is tinted and ringed, a disabled
                          // one recedes, so the grid is readable without reading.
                          // Tints sit ON the SectionCard surface now, so the
                          // muted state uses the secondary wash for its edge.
                          muted
                            ? 'bg-secondary/40 ring-1 ring-foreground/[0.04]'
                            : 'bg-primary/10 shadow-soft ring-1 ring-primary/25',
                        )}
                      >
                        {Icon && (
                          <span
                            aria-hidden
                            className={cn(
                              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-fast ease-out',
                              muted
                                ? 'bg-secondary/60 text-muted-foreground ring-1 ring-foreground/[0.04]'
                                : 'bg-primary/15 text-primary ring-1 ring-primary/20',
                            )}
                          >
                            <Icon size={18} />
                          </span>
                        )}
                        <div className="min-w-0 flex-1 pt-0.5">
                          <div
                            className={cn(
                              'text-sm font-medium transition-colors duration-fast ease-out',
                              muted ? 'text-foreground/90' : 'text-foreground',
                            )}
                          >
                            {t(`notifications.type.${type}`, { defaultValue: type })}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {t(meta?.descriptionKey ?? '', {
                              defaultValue: meta?.fallbackDescription ?? '',
                            })}
                          </p>
                          {!editingOrg && lockedByPolicy(type) && (
                            <p className="mt-1.5 text-xs font-medium text-muted-foreground">
                              {t('preferences.setByAdmin', {
                                defaultValue: 'Set for everyone by an administrator',
                              })}
                            </p>
                          )}
                        </div>
                        {/* Dropdown rather than a toggle: this is a four-way
                            choice (in-app / email / both / none), not on-off. */}
                        <SelectMenu
                          size="sm"
                          // Same green as the icon chip beside it — the control
                          // and the glyph then read as one component rather than
                          // a coloured icon next to a neutral form field. Muted
                          // rows keep the plain treatment so "none" still reads
                          // as switched off.
                          className={cn(
                            'w-28 shrink-0',
                            !muted &&
                              'border-primary/35 bg-primary/10 font-medium text-primary-strong hover:bg-primary/15',
                          )}
                          value={draft[type] ?? (editingOrg ? ORG_UNSET : 'both')}
                          onChange={(v: string) => setDraft((d) => ({ ...d, [type]: v }))}
                          aria-label={type}
                          /* Set by the organisation: say so and lock it, rather
                             than letting an agent pick something that would be
                             overruled the moment it was saved. A control that
                             accepts a choice and then ignores it is worse than
                             one that is plainly not theirs to make. */
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
                      </li>
                    );
                  })}
                </ul>
              </SectionCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
