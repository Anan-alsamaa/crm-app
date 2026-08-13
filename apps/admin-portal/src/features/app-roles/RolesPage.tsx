import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Pill,
  Skeleton,
  Textarea,
  Toolbar,
  ToolbarSpacer,
  cn,
  toast,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * Roles & privileges, the way the ops portal does it: a named role is a set of
 * ticked privileges, optionally fenced to specific brands.
 *
 * A row saved here is DECLARATIVE — the app-roles-sync extension inside
 * Directus turns it into a real role + policy + permission set, from a fixed
 * catalog whose ceiling is business access. Nothing assembled on this page can
 * grant admin access, no matter what is ticked; and the built-in roles
 * (Admin, Agent) appear locked because they are defined in code, where their
 * two security incidents' worth of hardening lives.
 *
 * The PRIVS list mirrors the extension's catalog — a tick with no catalog
 * entry is stripped server-side, so the two cannot drift into lying.
 */
const PRIVS: ReadonlyArray<{ key: string; group: string }> = [
  { key: 'use_chat', group: 'chat' },
  { key: 'view_all_chats', group: 'chat' },
  { key: 'view_tickets', group: 'tickets' },
  { key: 'view_all_tickets', group: 'tickets' },
  { key: 'create_tickets', group: 'tickets' },
  { key: 'edit_tickets', group: 'tickets' },
  { key: 'edit_all_tickets', group: 'tickets' },
  { key: 'delete_tickets', group: 'tickets' },
  { key: 'approve_coupons', group: 'tickets' },
  { key: 'view_dashboard', group: 'reporting' },
  { key: 'export_data', group: 'reporting' },
  { key: 'import_data', group: 'reporting' },
  { key: 'manage_lists', group: 'admin' },
  { key: 'manage_restaurants', group: 'admin' },
  { key: 'manage_users', group: 'admin' },
];

interface AppRole {
  id: string;
  name: string;
  description: string | null;
  privileges: Record<string, boolean> | null;
  brands: string[] | null;
  directus_role: string | null;
  builtin: boolean;
}
interface BrandRow {
  id: string;
  name: string;
}

const useAppRoles = () =>
  useQuery({
    queryKey: ['app-roles'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'app_roles' as never,
          {
            limit: -1,
            sort: ['builtin', 'name'],
            fields: [
              'id',
              'name',
              'description',
              'privileges',
              'brands',
              'directus_role',
              'builtin',
            ],
          } as never,
        ),
      )) as unknown as AppRole[],
  });

const useBrands = () =>
  useQuery({
    queryKey: ['brands-for-roles'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'brands' as never,
          { limit: -1, sort: ['name'], fields: ['id', 'name'] } as never,
        ),
      )) as unknown as BrandRow[],
  });

interface Draft {
  id: string | null;
  name: string;
  description: string;
  privileges: Record<string, boolean>;
  brands: string[];
}
const EMPTY: Draft = { id: null, name: '', description: '', privileges: {}, brands: [] };

export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const roles = useAppRoles();
  const brands = useBrands();
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const selected = useMemo(
    () => (roles.data ?? []).find((r) => r.id === draft.id) ?? null,
    [roles.data, draft.id],
  );

  // Directus errors carry the extension's own message ("reserved name",
  // "reassign its users first") — surface it verbatim, it is the explanation.
  const errText = (err: unknown) => {
    const e = err as { errors?: Array<{ message?: string }> };
    return (
      e?.errors?.[0]?.message ?? t('roles.saveError', { defaultValue: 'Could not save that role' })
    );
  };

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['app-roles'] });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        name: d.name.trim(),
        description: d.description.trim() || null,
        privileges: d.privileges,
        brands: d.brands.length ? d.brands : null,
      };
      return d.id
        ? directus.request(updateItem('app_roles' as never, d.id, body as never))
        : directus.request(createItem('app_roles' as never, body as never));
    },
    onSuccess: (created: unknown) => {
      invalidate();
      const id = (created as { id?: string })?.id ?? draft.id;
      if (id) setDraft((d) => ({ ...d, id }));
      toast.success(
        t('roles.saved', {
          defaultValue: 'Saved — the role and its permissions are being applied now.',
        }),
      );
    },
    onError: (err) => toast.error(errText(err)),
  });
  const removeRole = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('app_roles' as never, id)),
    onSuccess: () => {
      invalidate();
      setDraft(EMPTY);
      toast.success(t('roles.deleted', { defaultValue: 'Role deleted' }));
    },
    onError: (err) => toast.error(errText(err)),
  });

  // Re-sync the form when the selected row refetches (e.g. directus_role lands).
  useEffect(() => {
    if (!selected) return;
    setDraft({
      id: selected.id,
      name: selected.name,
      description: selected.description ?? '',
      privileges: { ...(selected.privileges ?? {}) },
      brands: [...(selected.brands ?? [])],
    });
  }, [selected]);

  const locked = selected?.builtin ?? false;
  const GROUPS: Record<string, string> = {
    chat: t('roles.groupChat', { defaultValue: 'Customer chat' }),
    tickets: t('roles.groupTickets', { defaultValue: 'Tickets' }),
    reporting: t('roles.groupReporting', { defaultValue: 'Dashboard & reports' }),
    admin: t('roles.groupAdmin', { defaultValue: 'Administration' }),
  };
  const PRIV_LABELS: Record<string, string> = {
    use_chat: t('roles.p.useChat', { defaultValue: 'Work the chat inbox' }),
    view_all_chats: t('roles.p.viewAllChats', { defaultValue: "See every agent's chats" }),
    view_tickets: t('roles.p.viewTickets', { defaultValue: 'View own tickets' }),
    view_all_tickets: t('roles.p.viewAllTickets', { defaultValue: 'View all tickets' }),
    create_tickets: t('roles.p.createTickets', { defaultValue: 'Create tickets' }),
    edit_tickets: t('roles.p.editTickets', { defaultValue: 'Edit own tickets' }),
    edit_all_tickets: t('roles.p.editAllTickets', { defaultValue: 'Edit any ticket' }),
    delete_tickets: t('roles.p.deleteTickets', { defaultValue: 'Delete tickets' }),
    approve_coupons: t('roles.p.approveCoupons', { defaultValue: 'Approve coupons' }),
    view_dashboard: t('roles.p.viewDashboard', { defaultValue: 'View dashboards & reports' }),
    export_data: t('roles.p.exportData', { defaultValue: 'Export to Excel/CSV' }),
    import_data: t('roles.p.importData', { defaultValue: 'Import complaints' }),
    manage_lists: t('roles.p.manageLists', { defaultValue: 'Edit dropdown lists & settings' }),
    manage_restaurants: t('roles.p.manageRestaurants', {
      defaultValue: 'Manage brands & branches',
    }),
    manage_users: t('roles.p.manageUsers', { defaultValue: 'Manage users' }),
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('roles.title', { defaultValue: 'Roles & privileges' })}
        </h1>
        <ToolbarSpacer />
        <Button size="sm" variant="secondary" onClick={() => setDraft(EMPTY)}>
          {t('roles.new', { defaultValue: 'New role' })}
        </Button>
      </Toolbar>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-[18rem_1fr]">
        {/* ── the roles ── */}
        <div className="space-y-2">
          {roles.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-xl" />
            ))
          ) : (
            <ul className="space-y-1.5">
              {(roles.data ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, id: r.id }))}
                    className={cn(
                      'w-full rounded-xl px-3 py-2.5 text-start transition-colors duration-fast',
                      draft.id === r.id
                        ? 'bg-primary/10 ring-1 ring-primary/30'
                        : 'bg-card shadow-soft ring-1 ring-foreground/[0.06] hover:bg-secondary/50',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {r.name}
                      </span>
                      {r.builtin ? (
                        <Pill tone="neutral" size="sm">
                          {t('roles.builtin', { defaultValue: 'Built-in' })}
                        </Pill>
                      ) : r.directus_role ? (
                        <Pill tone="success" size="sm">
                          {t('roles.active', { defaultValue: 'Active' })}
                        </Pill>
                      ) : (
                        <Pill tone="warning" size="sm">
                          {t('roles.pending', { defaultValue: 'Applying…' })}
                        </Pill>
                      )}
                    </span>
                    {r.brands && r.brands.length > 0 && (
                      <span className="mt-0.5 block text-2xs text-muted-foreground">
                        {t('roles.brandLimited', {
                          n: r.brands.length,
                          defaultValue: 'Limited to {{n}} brand(s)',
                        })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── the editor ── */}
        <div className="space-y-4">
          {locked ? (
            <div className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
              <h2 className="text-sm font-semibold text-foreground">{selected?.name}</h2>
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                {selected?.description}
              </p>
              <p className="mt-3 max-w-2xl rounded-xl bg-secondary/50 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                {t('roles.builtinHelp', {
                  defaultValue:
                    'Built-in roles are defined in code, where their security hardening lives, and cannot be edited here. Create a new role for anything these two do not cover.',
                })}
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06] sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t('roles.name', { defaultValue: 'Role name' })}
                  </span>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t('roles.namePlaceholder', {
                      defaultValue: 'e.g. Brand Supervisor',
                    })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t('roles.description', { defaultValue: 'Description' })}
                  </span>
                  <Textarea
                    rows={1}
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  />
                </label>
              </div>

              {/* privilege matrix */}
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries(GROUPS).map(([group, label]) => (
                  <fieldset
                    key={group}
                    className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]"
                  >
                    <legend className="sr-only">{label}</legend>
                    <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      {label}
                    </h3>
                    <ul className="space-y-1.5">
                      {PRIVS.filter((p) => p.group === group).map((p) => (
                        <li key={p.key}>
                          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-sm text-foreground hover:bg-secondary/50">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border text-primary focus:ring-primary/60"
                              checked={!!draft.privileges[p.key]}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  privileges: { ...d.privileges, [p.key]: e.target.checked },
                                }))
                              }
                            />
                            {PRIV_LABELS[p.key]}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ))}
              </div>

              {/* brand restriction */}
              <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
                <h3 className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t('roles.brands', { defaultValue: 'Brand access' })}
                </h3>
                <p className="mb-3 mt-1 max-w-2xl text-2xs leading-relaxed text-muted-foreground">
                  {t('roles.brandsHelp', {
                    defaultValue:
                      'Tick brands to fence this role to them: their tickets, their branches, their names in the pickers. Nothing ticked means every brand. Tickets not yet linked to a branch stay visible either way, and chats cannot be brand-fenced — a conversation has no brand until a ticket gives it one.',
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(brands.data ?? []).map((b) => {
                    const on = draft.brands.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            brands: on ? d.brands.filter((x) => x !== b.id) : [...d.brands, b.id],
                          }))
                        }
                        className={cn(
                          'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast',
                          on
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-secondary text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {b.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => save.mutate(draft)}
                  disabled={!draft.name.trim() || save.isPending}
                >
                  {draft.id
                    ? t('roles.save', { defaultValue: 'Save role' })
                    : t('roles.create', { defaultValue: 'Create role' })}
                </Button>
                {draft.id && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        window.confirm(
                          t('roles.deleteConfirm', {
                            name: draft.name,
                            defaultValue:
                              'Delete “{{name}}”? Users still holding it must be reassigned first.',
                          }),
                        )
                      )
                        removeRole.mutate(draft.id!);
                    }}
                  >
                    {t('roles.delete', { defaultValue: 'Delete' })}
                  </Button>
                )}
                <span className="text-2xs text-muted-foreground">
                  {t('roles.assignHint', {
                    defaultValue:
                      'Assign people to this role from the Users page once it shows Active.',
                  })}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
