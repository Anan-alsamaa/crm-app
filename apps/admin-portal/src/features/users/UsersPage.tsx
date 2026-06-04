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
  FormField,
  Input,
  Select,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { useUsers, useRoles, useCreateUser } from './api.js';
import { useTeams } from '../teams/api.js';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role: z.string().min(1),
  team: z.string().optional(),
  locale: z.enum(['en', 'ar']).optional(),
});
type FormValues = z.infer<typeof schema>;

export function UsersPage() {
  const { t } = useTranslation();
  const users = useUsers();
  const roles = useRoles();
  const teams = useTeams();
  const createUser = useCreateUser();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createUser.mutateAsync({ ...values, team: values.team || null });
      reset();
      setOpen(false);
      toast.success(t('users.created'));
    } catch {
      toast.error(t('users.createError'));
    }
  });

  const filtered = (users.data ?? []).filter((u) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const full = [u.first_name, u.last_name].filter(Boolean).join(' ').toLowerCase();
    return (
      (u.email ?? '').toLowerCase().includes(q) ||
      full.includes(q) ||
      (u.role?.name ?? '').toLowerCase().includes(q) ||
      (u.team?.name ?? '').toLowerCase().includes(q)
    );
  });

  const list = users.data ?? [];
  const total = list.length;
  const activeCount = list.filter((u) => u.status === 'active').length;
  const adminCount = list.filter((u) => u.role?.name?.toLowerCase() === 'administrator').length;
  const teamlessCount = list.filter((u) => !u.team).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Dense toolbar — title + inline stat pills + search + create */}
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">{t('users.title')}</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong>{' '}
            {t('users.statTotalCap', { defaultValue: 'total' })}
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{activeCount}</strong> active
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{adminCount}</strong> admin
          </span>
          {teamlessCount > 0 && (
            <>
              <span className="opacity-30">·</span>
              <span className="tabular-nums text-warning-foreground">
                <strong className="font-semibold">{teamlessCount}</strong> no team
              </span>
            </>
          )}
        </span>
        <ToolbarSpacer />
        <div className="relative w-56">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            placeholder={t('users.searchPlaceholder', {
              defaultValue: 'Search…',
            })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block h-8 w-full rounded-md border border-border bg-background/60 ps-8 pe-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start transition-colors duration-fast ease-out"
          />
        </div>
        <Button type="button" size="sm" onClick={() => setOpen(true)} iconStart={<PlusIcon />}>
          {t('users.create')}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {users.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="ms-auto h-3 w-16" />
              </div>
            ))}
          </div>
        ) : !users.data || users.data.length === 0 ? (
          <EmptyState
            title={t('users.empty')}
            description={t('users.emptyHint', {
              defaultValue: 'Invite your first teammate by clicking Create user.',
            })}
            action={
              <Button type="button" onClick={() => setOpen(true)} iconStart={<PlusIcon />}>
                {t('users.create')}
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t('users.noMatch', {
              defaultValue: 'No accounts match your search.',
            })}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((u, i) => {
              const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
              const isAdmin = u.role?.name?.toLowerCase() === 'administrator';
              return (
                <button
                  key={u.id}
                  type="button"
                  style={{ animationDelay: `${Math.min(i * 22, 220)}ms` }}
                  className={cn(
                    'group relative flex items-center gap-4 rounded-2xl bg-card/70 px-5 py-4 text-start',
                    'shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04]',
                    'transition-[box-shadow,transform,background-color] duration-fast ease-out',
                    'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08] hover:-translate-y-px',
                    'motion-safe:animate-fade-in',
                  )}
                >
                  <Avatar name={fullName} email={u.email} size="md" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline gap-2">
                      <div className="truncate text-sm font-medium text-foreground">
                        {fullName || u.email}
                      </div>
                      {u.status === 'active' ? (
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 rounded-full bg-success"
                          title="active"
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
                          title={u.status}
                        />
                      )}
                    </div>
                    {fullName && (
                      <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium',
                          isAdmin
                            ? 'bg-primary-subtle text-primary'
                            : 'bg-secondary text-muted-foreground',
                        )}
                      >
                        {u.role?.name ?? '—'}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-2xs',
                          u.team
                            ? 'bg-secondary text-muted-foreground'
                            : 'bg-warning/20 text-warning-foreground',
                        )}
                      >
                        {u.team?.name ?? t('users.noTeam')}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('users.create')}
        description={t('users.createHint', {
          defaultValue: 'New teammates get an invite email and can sign in immediately.',
        })}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" form="create-user-form" loading={isSubmitting}>
              {t('users.create')}
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={onSubmit} className="space-y-5" noValidate>
          <DrawerSection
            title={t('users.sectionIdentity', { defaultValue: 'Identity' })}
            description={t('users.sectionIdentityHint', {
              defaultValue: 'Who they are. Name is optional; email is the unique handle.',
            })}
          >
            <FormField label={t('users.email')} error={errors.email?.message}>
              <Input type="email" invalid={!!errors.email} {...register('email')} />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('users.firstName')}>
                <Input {...register('first_name')} />
              </FormField>
              <FormField label={t('users.lastName')}>
                <Input {...register('last_name')} />
              </FormField>
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('users.sectionAccess', { defaultValue: 'Access' })}
            description={t('users.sectionAccessHint', {
              defaultValue:
                'Role decides what they can do. Team decides where conversations route.',
            })}
          >
            <FormField label={t('users.role')} error={errors.role?.message}>
              <Select defaultValue="" invalid={!!errors.role} {...register('role')}>
                <option value="" disabled>
                  —
                </option>
                {roles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('users.team')}>
              <Select defaultValue="" {...register('team')}>
                <option value="">{t('users.noTeam')}</option>
                {teams.data?.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </DrawerSection>

          <DrawerSection
            title={t('users.sectionCredentials', { defaultValue: 'Credentials & locale' })}
            description={t('users.sectionCredentialsHint', {
              defaultValue: 'Set an initial password and their default UI language.',
            })}
          >
            <FormField
              label={t('auth.password', { ns: 'common' })}
              error={errors.password?.message}
              hint={t('users.passwordHint', { defaultValue: 'At least 6 characters.' })}
            >
              <Input type="password" invalid={!!errors.password} {...register('password')} />
            </FormField>
            <FormField label={t('users.locale')}>
              <Select defaultValue="en" {...register('locale')}>
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </FormField>
          </DrawerSection>
        </form>
      </Drawer>
    </div>
  );
}

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
