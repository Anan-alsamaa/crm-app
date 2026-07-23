import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  ConfirmDialog,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  SelectMenu,
  Skeleton,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useUsers,
  useRoles,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  type AdminUser,
} from './api.js';
import { useTeams } from '../teams/api.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

const schema = z.object({
  email: z.string().email(),
  // Optional so editing doesn't force a password reset; required-on-create is
  // enforced in onSubmit.
  password: z.string().min(6).optional().or(z.literal('')),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role: z.string().min(1),
  team: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  locale: z.enum(['en', 'ar']).optional(),
});
type FormValues = z.infer<typeof schema>;

export function UsersPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const users = useUsers();
  const roles = useRoles();
  const teams = useTeams();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const openCreate = () => {
    setEditing(null);
    // Pre-select Agent — the overwhelmingly common case — so creating a teammate
    // is one click. The field stays visible + changeable. Falls back to empty if
    // no Agent role exists (forcing an explicit pick).
    const agentRole = (roles.data ?? []).find((r) => r.name.toLowerCase() === 'agent');
    reset({
      email: '',
      password: '',
      first_name: '',
      last_name: '',
      role: agentRole?.id ?? '',
      team: '',
      locale: 'en',
    });
    setOpen(true);
  };
  const openEdit = (u: AdminUser) => {
    setEditing(u);
    reset({
      email: u.email ?? '',
      password: '',
      first_name: u.first_name ?? '',
      last_name: u.last_name ?? '',
      role: u.role?.id ?? '',
      team: u.team?.id ?? '',
      status: (u.status as 'active' | 'inactive') ?? 'active',
    });
    setOpen(true);
  };

  // Guard against locking yourself out / removing the project owner.
  const isSelf = editing?.id === currentUser?.id;
  const isOwner = editing?.role?.name?.toLowerCase() === 'administrator';
  const canDelete = !!editing && !isSelf && !isOwner;

  // Administrator is the system superuser (full schema + permission control) and
  // must NOT be assignable from the portal — granting it is a privilege-escalation
  // risk. We drop it from the selectable roles, keeping it only when editing
  // someone who is ALREADY an Administrator, so their role still displays and is
  // never silently downgraded on save.
  const roleOptions = (roles.data ?? [])
    .filter((r) => r.name.toLowerCase() !== 'administrator' || isOwner)
    .map((r) => ({ value: r.id, label: r.name }));

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (editing) {
        const patch: Record<string, unknown> = {
          email: values.email,
          first_name: values.first_name || null,
          last_name: values.last_name || null,
          role: values.role,
          team: values.team || null,
          status: values.status ?? 'active',
        };
        if (values.password) patch.password = values.password;
        await updateUser.mutateAsync({ id: editing.id, patch });
        toast.success(t('users.updated', { defaultValue: 'User updated.' }));
      } else {
        if (!values.password) {
          toast.error(t('users.passwordRequired', { defaultValue: 'Password is required.' }));
          return;
        }
        await createUser.mutateAsync({
          email: values.email,
          password: values.password,
          first_name: values.first_name,
          last_name: values.last_name,
          role: values.role,
          team: values.team || null,
          locale: values.locale,
        });
        toast.success(t('users.created'));
      }
      reset();
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(
        editing
          ? t('users.saveError', { defaultValue: 'Could not save.' })
          : t('users.createError'),
      );
    }
  });

  const onDelete = async () => {
    if (!editing || !canDelete) return;
    try {
      await deleteUser.mutateAsync(editing.id);
      toast.success(t('users.deleted', { defaultValue: 'User deleted.' }));
      setConfirmDelete(false);
      setOpen(false);
      setEditing(null);
    } catch {
      toast.error(t('users.deleteError', { defaultValue: 'Could not delete user.' }));
    }
  };

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
            aria-label={t('users.searchPlaceholder', { defaultValue: 'Search…' })}
            placeholder={t('users.searchPlaceholder', {
              defaultValue: 'Search…',
            })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block h-8 w-full rounded-md border border-border bg-background/60 ps-8 pe-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start transition-colors duration-fast ease-out"
          />
        </div>
        <Button type="button" size="sm" onClick={openCreate} iconStart={<PlusIcon />}>
          {t('users.create')}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {users.isError ? (
          <ErrorState
            title={t('users.loadError', { defaultValue: 'Could not load users' })}
            message={t('users.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void users.refetch()}
          />
        ) : users.isLoading ? (
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
              <Button type="button" onClick={openCreate} iconStart={<PlusIcon />}>
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
          /* Dense list — one row per account (density is a feature). Hairline
             dividers, no card chrome, columns read like a table at sm+. */
          <ul className="mx-auto max-w-5xl divide-y divide-border">
            {filtered.map((u) => {
              const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
              const isAdmin = u.role?.name?.toLowerCase() === 'administrator';
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => openEdit(u)}
                    className={cn(
                      'group flex w-full items-center gap-3 px-4 py-2.5 text-start',
                      'transition-colors duration-fast ease-out hover:bg-secondary/50',
                      'focus-visible:outline-none focus-visible:bg-secondary/60',
                    )}
                  >
                    <span className="relative shrink-0">
                      <Avatar name={fullName} email={u.email} size="sm" />
                      <span
                        aria-hidden
                        title={u.status}
                        className={cn(
                          'absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card',
                          u.status === 'active' ? 'bg-success' : 'bg-muted-foreground/40',
                        )}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {fullName || u.email}
                      </div>
                      {fullName && (
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'hidden shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-medium sm:inline-flex',
                        isAdmin
                          ? 'bg-primary-subtle text-primary'
                          : 'bg-secondary text-foreground/75',
                      )}
                    >
                      {u.role?.name ?? '—'}
                    </span>
                    <span
                      title={u.team?.name ?? t('users.noTeam')}
                      className={cn(
                        'hidden w-32 shrink-0 truncate text-end text-xs sm:block',
                        u.team ? 'text-muted-foreground' : 'text-warning-foreground',
                      )}
                    >
                      {u.team?.name ?? t('users.noTeam')}
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
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        title={editing ? t('users.edit', { defaultValue: 'Edit user' }) : t('users.create')}
        description={
          editing
            ? t('users.editHint', {
                defaultValue: 'Update role, team, status, or reset the password.',
              })
            : t('users.createHint', {
                defaultValue: 'New teammates get an invite email and can sign in immediately.',
              })
        }
        footer={
          <>
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive hover:bg-destructive/10 me-auto"
              >
                {t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
              </Button>
            )}
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
            <Button type="submit" form="create-user-form" loading={isSubmitting}>
              {editing
                ? t('actions.save', { ns: 'common', defaultValue: 'Save' })
                : t('users.create')}
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
            <FormField
              label={t('users.role')}
              error={errors.role?.message}
              hint={t('users.roleHint', {
                defaultValue:
                  'Admin can open this admin portal and manage settings, users, and every conversation. Agent handles only their own assigned queue in the agent portal.',
              })}
            >
              <Controller
                control={control}
                name="role"
                defaultValue=""
                render={({ field }) => (
                  <SelectMenu
                    fullWidth
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    invalid={!!errors.role}
                    aria-label={t('users.role')}
                    placeholder="—"
                    options={roleOptions}
                  />
                )}
              />
            </FormField>
            <FormField label={t('users.team')}>
              <Controller
                control={control}
                name="team"
                defaultValue=""
                render={({ field }) => (
                  <SelectMenu
                    fullWidth
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    aria-label={t('users.team')}
                    options={[
                      { value: '', label: t('users.noTeam') },
                      ...(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })),
                    ]}
                  />
                )}
              />
            </FormField>
            {editing && (
              <FormField
                label={t('users.status', { defaultValue: 'Status' })}
                hint={t('users.statusHint', {
                  defaultValue: 'Inactive accounts cannot sign in but keep their data.',
                })}
              >
                <Controller
                  control={control}
                  name="status"
                  defaultValue="active"
                  render={({ field }) => (
                    <SelectMenu
                      fullWidth
                      value={field.value ?? 'active'}
                      onChange={field.onChange}
                      aria-label={t('users.status', { defaultValue: 'Status' })}
                      options={[
                        { value: 'active', label: t('users.active', { defaultValue: 'Active' }) },
                        {
                          value: 'inactive',
                          label: t('users.inactive', { defaultValue: 'Inactive' }),
                        },
                      ]}
                    />
                  )}
                />
              </FormField>
            )}
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
              hint={
                editing
                  ? t('users.passwordEditHint', {
                      defaultValue: 'Leave blank to keep the current password.',
                    })
                  : t('users.passwordHint', { defaultValue: 'At least 6 characters.' })
              }
            >
              <Input type="password" invalid={!!errors.password} {...register('password')} />
            </FormField>
            {!editing && (
              <FormField label={t('users.locale')}>
                <Controller
                  control={control}
                  name="locale"
                  defaultValue="en"
                  render={({ field }) => (
                    <SelectMenu
                      fullWidth
                      value={field.value ?? 'en'}
                      onChange={field.onChange}
                      aria-label={t('users.locale')}
                      options={[
                        { value: 'en', label: 'English' },
                        { value: 'ar', label: 'العربية' },
                      ]}
                    />
                  )}
                />
              </FormField>
            )}
          </DrawerSection>
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirmDelete}
        destructive
        title={t('users.confirmDelete', { defaultValue: 'Delete this account permanently?' })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
        loading={deleteUser.isPending}
        onConfirm={() => void onDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
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
