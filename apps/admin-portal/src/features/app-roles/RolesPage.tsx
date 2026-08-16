import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, deleteItem, readItems, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ChartIcon,
  InboxIcon,
  Input,
  MeterBar,
  Pill,
  SectionCard,
  ShieldIcon,
  Skeleton,
  Textarea,
  TicketIcon,
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

/* One hue per capability area, so a role's shape is legible before reading a
 * single label: chat is sky, tickets jade, reporting violet, administration
 * red — the same ranking the catalogue itself implies. */
const GROUP_CHIPS: Record<string, string> = {
  chat: 'bg-sky-tint text-sky',
  tickets: 'bg-primary-tint text-primary',
  reporting: 'bg-violet-tint text-violet',
  admin: 'bg-destructive-tint text-destructive',
};

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

  const GROUP_ICONS: Record<string, React.ReactNode> = {
    chat: <InboxIcon size={15} />,
    tickets: <TicketIcon size={15} />,
    reporting: <ChartIcon size={15} />,
    admin: <ShieldIcon size={15} />,
  };
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
        <Button size="sm" onClick={() => setDraft(EMPTY)} iconStart={<PlusIcon />}>
          {t('roles.new', { defaultValue: 'New role' })}
        </Button>
      </Toolbar>

      {/* Scroll lives on the page wrapper; the grid inside is capped so the
          editor doesn't stretch full-bleed across wide monitors. */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto grid w-full max-w-[92rem] grid-cols-1 gap-5 lg:grid-cols-[20rem_1fr] lg:items-start">
          {/* ── page hero — the boards' header anatomy ── */}
          <div className="border-b border-foreground/10 pb-5 lg:col-span-2">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('roles.heroSubtitle', {
                defaultValue:
                  'Named sets of ticked privileges, optionally fenced to specific brands. Pick a role to see or change what it can do.',
              })}
            </p>
          </div>

          {/* ── the roles ── */}
          <div className="space-y-2">
            {roles.isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))
            ) : (
              /* Clean board list — rows flush inside one card, hairline
               separators, quiet hover; the selected row is jade-tinted. */
              <div className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] lg:sticky lg:top-4">
                <div className="flex items-center justify-between gap-2 border-b border-foreground/[0.07] px-3.5 py-2.5">
                  <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('roles.listTitle', { defaultValue: 'Roles' })}
                  </span>
                  {/* Nothing could clear a selection once made, so a built-in
                      role's read-only panel became a dead end. */}
                  {draft.id && (
                    <button
                      type="button"
                      onClick={() => setDraft(EMPTY)}
                      className="rounded-md px-1.5 py-0.5 text-2xs font-semibold text-primary transition-colors duration-fast hover:bg-primary/10"
                    >
                      {t('roles.clearSelection', { defaultValue: 'Clear' })}
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-foreground/[0.06]">
                  {(roles.data ?? []).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, id: r.id }))}
                        className={cn(
                          'min-h-12 w-full px-3.5 py-2.5 text-start transition-colors duration-fast',
                          'focus-visible:outline-none focus-visible:bg-foreground/[0.05]',
                          draft.id === r.id
                            ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
                            : 'hover:bg-foreground/[0.03]',
                        )}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className={cn(
                              'grid h-8 w-8 shrink-0 place-items-center rounded-xl text-2xs font-bold uppercase',
                              r.builtin
                                ? 'bg-secondary text-muted-foreground'
                                : 'bg-primary-tint text-primary',
                            )}
                          >
                            {r.name.slice(0, 2)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
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
                        {/* Permission count under the name — the reference
                            boards' "12 permissions" chip, as quiet text. */}
                        <span className="mt-0.5 block text-2xs tabular-nums text-muted-foreground">
                          {t('roles.privCount', {
                            n: Object.values(r.privileges ?? {}).filter(Boolean).length,
                            defaultValue: '{{n}} privileges',
                          })}
                          {r.brands && r.brands.length > 0 && (
                            <>
                              {' · '}
                              {t('roles.brandLimited', {
                                n: r.brands.length,
                                defaultValue: 'Limited to {{n}} brand(s)',
                              })}
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {/* Footer aggregate band — the boards' table anatomy, matching
                every other board list in the portal. */}
                <div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] bg-secondary/30 px-3.5 py-2.5">
                  <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('roles.total', { defaultValue: 'roles' })}
                  </span>
                  <span className="text-sm font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
                    {(roles.data ?? []).length}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* ── the editor ── */}
          <div className="space-y-4">
            {locked ? (
              <div className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">
                  {selected?.name}
                </h2>
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
                <div className="grid gap-3 rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06] sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
                  <label className="flex flex-col gap-1.5">
                    <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('roles.description', { defaultValue: 'Description' })}
                    </span>
                    <Textarea
                      rows={1}
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    />
                  </label>
                </div>

                {/* privilege matrix — SectionCard-like group cards: compact
                  title header, hairline-separated tick rows, jade ticks.
                  items-start keeps a two-item card from stretching to its
                  seven-item neighbour's height and hoarding dead space. */}
                <div className="grid items-start gap-4 sm:grid-cols-2 2xl:grid-cols-4">
                  {Object.entries(GROUPS).map(([group, label]) => {
                    const groupPrivs = PRIVS.filter((p) => p.group === group);
                    const ticked = groupPrivs.filter((p) => !!draft.privileges[p.key]).length;
                    return (
                      <fieldset
                        key={group}
                        className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]"
                      >
                        <legend className="sr-only">{label}</legend>
                        {/* Each capability area is identified by a tinted glyph
                            and shows how much of it this role has been given —
                            four identical grey cards told an admin nothing at a
                            glance about where a role's power actually sits. */}
                        <div className="border-b border-foreground/[0.06] pb-3">
                          <div className="flex items-center gap-2.5">
                            <span
                              aria-hidden
                              className={cn(
                                'grid h-8 w-8 shrink-0 place-items-center rounded-xl',
                                GROUP_CHIPS[group] ?? 'bg-secondary text-muted-foreground',
                              )}
                            >
                              {GROUP_ICONS[group]}
                            </span>
                            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
                              {label}
                            </h3>
                            <span
                              className={cn(
                                'shrink-0 text-2xs font-semibold tabular-nums',
                                ticked > 0 ? 'text-primary' : 'text-muted-foreground',
                              )}
                            >
                              {ticked}/{groupPrivs.length}
                            </span>
                          </div>
                          <div className="mt-2.5 flex items-center gap-3">
                            <MeterBar
                              value={(ticked / groupPrivs.length) * 100}
                              tone="primary"
                              className="flex-1"
                            />
                            {/* Granting a whole area is the common case; ticking
                                seven switches one at a time was busywork. */}
                            <button
                              type="button"
                              onClick={() =>
                                setDraft((d) => {
                                  const all = ticked === groupPrivs.length;
                                  const next = { ...d.privileges };
                                  for (const gp of groupPrivs) next[gp.key] = !all;
                                  return { ...d, privileges: next };
                                })
                              }
                              className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-semibold text-primary transition-colors duration-fast hover:bg-primary/10"
                            >
                              {ticked === groupPrivs.length
                                ? t('roles.clearGroup', { defaultValue: 'None' })
                                : t('roles.allGroup', { defaultValue: 'All' })}
                            </button>
                          </div>
                        </div>
                        <ul className="mt-1 divide-y divide-foreground/[0.06]">
                          {groupPrivs.map((p) => (
                            <li key={p.key}>
                              {/* Toggle switch, label first — the permission
                                  rows of the reference console. The thumb
                                  moves via the logical inset so RTL slides the
                                  right way. */}
                              <label className="flex min-h-9 cursor-pointer items-center justify-between gap-2.5 rounded-md px-1.5 py-1.5 text-sm text-foreground transition-colors duration-fast hover:bg-foreground/[0.03]">
                                <span className="min-w-0 flex-1">{PRIV_LABELS[p.key]}</span>
                                <span className="relative inline-flex shrink-0">
                                  <input
                                    type="checkbox"
                                    className="peer sr-only"
                                    checked={!!draft.privileges[p.key]}
                                    onChange={(e) =>
                                      setDraft((d) => ({
                                        ...d,
                                        privileges: { ...d.privileges, [p.key]: e.target.checked },
                                      }))
                                    }
                                  />
                                  <span
                                    aria-hidden
                                    className="block h-6 w-11 rounded-full bg-foreground/15 transition-colors duration-fast peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50"
                                  />
                                  <span
                                    aria-hidden
                                    className="pointer-events-none absolute top-0.5 start-0.5 h-5 w-5 rounded-full bg-card shadow-md transition-all duration-fast peer-checked:start-[1.375rem]"
                                  />
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </fieldset>
                    );
                  })}
                </div>

                {/* brand restriction — the shared SectionCard surface */}
                <SectionCard
                  title={t('roles.brands', { defaultValue: 'Brand access' })}
                  hint={t('roles.brandsHelp', {
                    defaultValue:
                      'Tick brands to fence this role to them: their tickets, their branches, their names in the pickers. Nothing ticked means every brand. Tickets not yet linked to a branch stay visible either way, and chats cannot be brand-fenced — a conversation has no brand until a ticket gives it one.',
                  })}
                >
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
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            // Tinted chip with hue text — the boards' tag-pill
                            // treatment for the ticked state.
                            on
                              ? 'bg-primary-tint text-primary ring-1 ring-inset ring-primary/30'
                              : 'bg-secondary text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {b.name}
                        </button>
                      );
                    })}
                  </div>
                </SectionCard>

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
