import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  ProgressRing,
  Skeleton,
  StatCard,
  TeamIcon,
  Textarea,
  toast,
  Toolbar,
  ToolbarSpacer,
  UsersIcon,
  ZapIcon,
} from '@yiji/ui';
import { useTeams, useCreateTeam, useUpdateTeam, useDeleteTeam, type Team } from './api.js';
import { useUsers } from '../users/api.js';

const schema = z.object({ name: z.string().min(1), description: z.string().optional() });
type FormValues = z.infer<typeof schema>;

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function TeamsPage() {
  const { t } = useTranslation();
  const teams = useTeams();
  const users = useUsers();
  const createTeam = useCreateTeam();
  const updateTeam = useUpdateTeam();
  const deleteTeam = useDeleteTeam();
  const [open, setOpen] = useState(false);
  /**
   * The team being edited, or null when the drawer is creating a new one.
   *
   * One drawer serves both: the fields are identical, and a second copy would
   * be one more place for the two to drift apart.
   */
  const [editing, setEditing] = useState<Team | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const openCreate = () => {
    setEditing(null);
    reset({ name: '', description: '' });
    setOpen(true);
  };

  const openEdit = (tm: Team) => {
    setEditing(tm);
    reset({ name: tm.name, description: tm.description ?? '' });
    setOpen(true);
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (editing) {
        await updateTeam.mutateAsync({ id: editing.id, ...values });
        toast.success(t('teams.updated', { defaultValue: 'Team saved.' }));
      } else {
        await createTeam.mutateAsync(values);
        toast.success(t('teams.created'));
      }
      reset();
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('teams.createError'));
    }
  });

  const onDelete = async () => {
    if (!editing) return;
    try {
      await deleteTeam.mutateAsync(editing.id);
      // Said plainly, because it is the part people do not expect: the team
      // goes, the agents do not.
      toast.success(
        t('teams.deleted', { defaultValue: 'Team deleted. Its agents are now unassigned.' }),
      );
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('teams.deleteError', { defaultValue: 'Could not delete that team.' }));
    }
  };

  const teamCount = teams.data?.length ?? 0;
  const userCount = users.data?.length ?? 0;
  const assignedCount = (users.data ?? []).filter((u) => u.team).length;
  const unassignedCount = userCount - assignedCount;
  const assignedPct = userCount > 0 ? Math.round((assignedCount / userCount) * 100) : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">{t('teams.title')}</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{teamCount}</strong>{' '}
            {t('teams.statTeamsCap', { defaultValue: 'teams' })}
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{assignedCount}</strong>{' '}
            {t('teams.statAssignedCap', { defaultValue: 'assigned' })}
          </span>
          {unassignedCount > 0 && (
            <>
              <span className="opacity-30">·</span>
              {/* Bare warning ink is near-invisible on the dark canvas — the
                  tinted chip treatment stays readable on both themes. */}
              <span className="rounded-full bg-warning/20 px-2 py-0.5 tabular-nums text-warning-foreground">
                <strong className="font-semibold">{unassignedCount}</strong>{' '}
                {t('teams.statUnassignedCap', { defaultValue: 'unassigned' })}
              </span>
            </>
          )}
        </span>
        <ToolbarSpacer />
        <Button type="button" size="sm" onClick={openCreate} iconStart={<PlusIcon />}>
          {t('teams.create')}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        {!teams.isLoading && !teams.isError && teamCount > 0 && (
          <div className="mx-auto mb-5 max-w-5xl space-y-5">
            <div className="border-b border-foreground/10 pb-5">
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t('teams.heroSubtitle', {
                  defaultValue:
                    'Groups that decide where conversations and tickets route. See each team, who belongs to it, and who still needs a home.',
                })}
              </p>
            </div>
            {/* Boxed board tiles — tinted icon chips, hero numerals; tone lives
                in the chip / dot, never in a colored outline. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                icon={<TeamIcon />}
                tone="primary"
                label={t('teams.total', { defaultValue: 'teams' })}
                value={teamCount}
              />
              <StatCard
                icon={<UsersIcon />}
                tone="pink"
                label={t('teams.members', { defaultValue: 'members' })}
                value={userCount}
              />
              <StatCard
                icon={<ZapIcon />}
                tone="success"
                label={t('teams.assigned', { defaultValue: 'assigned' })}
                value={assignedCount}
                visual={
                  <span className="hidden sm:block">
                    <ProgressRing
                      value={assignedPct}
                      tone="success"
                      size={40}
                      label={`${assignedPct}%`}
                    />
                  </span>
                }
              />
              {/* No icon here on purpose: the warning hue may not tint a chip
                  (light-token contrast), so the label dot carries it. */}
              <StatCard
                tone={unassignedCount > 0 ? 'warning' : 'default'}
                label={t('teams.unassigned', { defaultValue: 'unassigned' })}
                value={unassignedCount}
              />
            </div>
          </div>
        )}
        {teams.isError ? (
          <ErrorState
            title={t('teams.loadError', { defaultValue: 'Could not load teams' })}
            message={t('teams.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void teams.refetch()}
          />
        ) : teams.isLoading ? (
          <div className="mx-auto max-w-5xl divide-y divide-foreground/[0.06] rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-3">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-2.5 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : !teams.data || teams.data.length === 0 ? (
          <EmptyState
            title={t('teams.empty')}
            description={t('teams.emptyHint', {
              defaultValue: 'Create your first team to start routing conversations.',
            })}
            action={
              <Button type="button" onClick={openCreate} iconStart={<PlusIcon />}>
                {t('teams.create')}
              </Button>
            }
          />
        ) : (
          /* Dense list — one row per team, flush inside one board card:
             hairline separators, quiet hover, a footer aggregate band.
             Members shown as a small avatar stack with an overflow count. */
          <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft">
            <ul className="divide-y divide-foreground/[0.06]">
              {teams.data.map((tm) => {
                const members = (users.data ?? []).filter((u) => u.team?.id === tm.id);
                const memberCount = members.length;
                return (
                  <li key={tm.id}>
                    <button
                      type="button"
                      onClick={() => openEdit(tm)}
                      title={t('teams.editHint', { defaultValue: 'Edit this team' })}
                      className={cn(
                        'group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start',
                        'transition-colors duration-fast ease-out hover:bg-foreground/[0.03]',
                        'focus-visible:outline-none focus-visible:bg-foreground/[0.05]',
                      )}
                    >
                      {/* Tinted initial chip — the boards' icon-chip anatomy. */}
                      <span
                        aria-hidden
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-tint text-sm font-semibold text-primary"
                      >
                        {tm.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-foreground">
                          {tm.name}
                        </div>
                        {tm.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {tm.description}
                          </div>
                        )}
                      </div>
                      {/* The count cell already says "0 members" — repeating it
                          as an italic "no members" read as a stutter, so an
                          empty team simply shows no avatar stack. */}
                      {memberCount > 0 && (
                        <div className="flex shrink-0 items-center -space-x-1.5">
                          {members.slice(0, 4).map((m) => {
                            const fn = [m.first_name, m.last_name].filter(Boolean).join(' ');
                            return (
                              <span key={m.id} className="rounded-full ring-2 ring-card">
                                <Avatar name={fn} email={m.email} size="xs" />
                              </span>
                            );
                          })}
                          {memberCount > 4 && (
                            <span className="ms-2.5 text-2xs text-muted-foreground tabular-nums">
                              +{memberCount - 4}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Right-aligned tabular numbers — the boards' table idiom. */}
                      <span
                        className={cn(
                          'w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground',
                          memberCount === 0 && 'text-muted-foreground/70',
                        )}
                      >
                        <span
                          className={cn(
                            'font-semibold',
                            memberCount > 0 ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {memberCount}
                        </span>{' '}
                        {memberCount === 1
                          ? t('teams.memberOne', { defaultValue: 'member' })
                          : t('teams.memberOther', { defaultValue: 'members' })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* Footer aggregate band — the boards' table anatomy. */}
            <div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] bg-secondary/30 px-4 py-2.5">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('teams.total', { defaultValue: 'teams' })}
              </span>
              <span className="text-sm font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
                {teamCount}
              </span>
            </div>
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        title={editing ? t('teams.edit', { defaultValue: 'Edit team' }) : t('teams.create')}
        description={t('teams.createHint', {
          defaultValue:
            'Teams group agents so conversations and tickets route to the right people.',
        })}
        footer={
          <>
            {/* Delete sits apart, on the far side of the footer — a destructive
                action next to Save is a mis-click waiting to happen. */}
            {editing && (
              <Button
                type="button"
                variant="destructive"
                onClick={onDelete}
                loading={deleteTeam.isPending}
              >
                {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
              </Button>
            )}
            <ToolbarSpacer />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setEditing(null);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="create-team-form" loading={isSubmitting}>
              {editing
                ? t('actions.save', { ns: 'common', defaultValue: 'Save' })
                : t('teams.create')}
            </Button>
          </>
        }
      >
        <form id="create-team-form" onSubmit={onSubmit} className="space-y-5" noValidate>
          <DrawerSection
            title={t('teams.sectionIdentity', { defaultValue: 'Team identity' })}
            description={t('teams.sectionIdentityHint', {
              defaultValue: 'Name appears in the agent inbox and on routing rules.',
            })}
          >
            <FormField label={t('teams.name')} error={errors.name?.message}>
              <Input invalid={!!errors.name} {...register('name')} />
            </FormField>
            <FormField
              label={t('teams.description')}
              hint={t('teams.descriptionHint', {
                defaultValue: 'A short blurb about what this team handles.',
              })}
            >
              <Textarea rows={4} {...register('description')} />
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('teams.sectionMembers', { defaultValue: 'Members' })}
            description={t('teams.sectionMembersHint', {
              defaultValue: 'Members are assigned from the Users page.',
            })}
          >
            {/* Composed note panel — the same quiet-surface treatment the
                roles page uses for its built-in explainer, so this reads as a
                deliberate aside instead of a stray text line. */}
            <p className="rounded-xl bg-secondary/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t('teams.membersHelper', {
                defaultValue:
                  'You can assign agents to this team from the Users page once the team is created.',
              })}
            </p>
          </DrawerSection>
        </form>
      </Drawer>
    </div>
  );
}
