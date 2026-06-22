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
  Skeleton,
  Textarea,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { useTeams, useCreateTeam } from './api.js';
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
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createTeam.mutateAsync(values);
      reset();
      setOpen(false);
      toast.success(t('teams.created'));
    } catch {
      toast.error(t('teams.createError'));
    }
  });

  const teamCount = teams.data?.length ?? 0;
  const userCount = users.data?.length ?? 0;
  const assignedCount = (users.data ?? []).filter((u) => u.team).length;
  const unassignedCount = userCount - assignedCount;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">{t('teams.title')}</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{teamCount}</strong> teams
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{assignedCount}</strong> assigned
          </span>
          {unassignedCount > 0 && (
            <>
              <span className="opacity-30">·</span>
              <span className="tabular-nums text-warning-foreground">
                <strong className="font-semibold">{unassignedCount}</strong> unassigned
              </span>
            </>
          )}
        </span>
        <ToolbarSpacer />
        <Button type="button" size="sm" onClick={() => setOpen(true)} iconStart={<PlusIcon />}>
          {t('teams.create')}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
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
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-3">
                <Skeleton className="h-8 w-8 rounded-md" />
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
              <Button type="button" onClick={() => setOpen(true)} iconStart={<PlusIcon />}>
                {t('teams.create')}
              </Button>
            }
          />
        ) : (
          /* Dense list — one row per team. Members shown as a small avatar
             stack with an overflow count; no card chrome. */
          <ul className="mx-auto max-w-5xl divide-y divide-border/50 overflow-hidden rounded-xl bg-card/50 ring-1 ring-border/60">
            {teams.data.map((tm) => {
              const members = (users.data ?? []).filter((u) => u.team?.id === tm.id);
              const memberCount = members.length;
              return (
                <li key={tm.id}>
                  <button
                    type="button"
                    className={cn(
                      'group flex w-full items-center gap-3 px-4 py-2.5 text-start',
                      'transition-colors duration-fast ease-out hover:bg-secondary/50',
                      'focus-visible:outline-none focus-visible:bg-secondary/60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{tm.name}</div>
                      {tm.description && (
                        <div className="truncate text-xs text-muted-foreground">
                          {tm.description}
                        </div>
                      )}
                    </div>
                    {memberCount > 0 ? (
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
                    ) : (
                      <span className="shrink-0 text-2xs italic text-muted-foreground/70">
                        no members
                      </span>
                    )}
                    <span className="w-20 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                      {memberCount} {memberCount === 1 ? 'member' : 'members'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('teams.create')}
        description={t('teams.createHint', {
          defaultValue:
            'Teams group agents so conversations and tickets route to the right people.',
        })}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="create-team-form" loading={isSubmitting}>
              {t('teams.create')}
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
              defaultValue: 'Assign members from the Users page after creating the team.',
            })}
          >
            <p className="text-xs text-muted-foreground">
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
