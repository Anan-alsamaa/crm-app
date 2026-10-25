import { useEffect, useMemo, useRef, useState } from 'react';
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
  cn,
  toast,
} from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { BranchPicker } from './BranchPicker.js';
import {
  PRIVILEGE_PORTAL,
  ALL_PRIVILEGES,
  PRIVILEGES,
  PRIVILEGE_GROUP,
  DASHBOARD_PRIVILEGES,
  REPORT_ACCESS_PRIVILEGES,
  effectivePrivileges,
  isOwnerPrivilege,
  type Privilege,
} from '../../lib/privileges.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { FIELD_LABEL, PAGE_BODY, PageHeader, SECTION_CARD } from '../../components/shell/Page.js';
import { ClearFiltersButton } from '../../components/ClearFiltersButton.js';

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
 * The list comes from lib/privileges — the same one `useAuth().can()` reads to
 * decide what each screen offers, so a privilege ticked here and a button shown
 * over there cannot mean different things. The extension's CATALOG stays the
 * authority on what a tick GRANTS: a tick with no catalog entry is stripped
 * server-side, which is what stops the two drifting into lying.
 */
/*
 * TWO LISTS, ONE PAGE (owner, 2026-10-06). The Administrator sees every
 * permission, the fine-grained ones included; everyone else who can open this
 * page sees exactly the list they always had. The server keeps the owner's
 * switches out of their saves too (app-roles-sync `keepOwnerPrivileges`).
 */
const toPrivs = (keys: readonly Privilege[]) =>
  keys.map((key) => ({ key, group: PRIVILEGE_GROUP[key] as string }));
const SHARED_PRIVS = toPrivs(PRIVILEGES);
/* The owner sees one line per dashboard and per report instead of the old
   "View dashboards & reports" (owner, 2026-10-12); `view_dashboard` becomes
   plumbing, set on save from those lines (see `ownerSaveShape`). */
const OWNER_PRIVS = toPrivs(ALL_PRIVILEGES.filter((k) => k !== 'view_dashboard'));

/**
 * What the owner's save stores. The two boards are written out explicitly -
 * the value the editor showed, defaults included - so later changes elsewhere
 * cannot move them; and `view_dashboard`, no longer a line, follows the
 * dashboard and report lines: on if any of them is.
 */
export function ownerSaveShape(
  privileges: Record<string, boolean>,
  roleName: string,
): Record<string, boolean> {
  const eff = effectivePrivileges(privileges, roleName);
  const next = { ...privileges };
  for (const k of DASHBOARD_PRIVILEGES) next[k] = eff[k] === true;
  next.view_dashboard = REPORT_ACCESS_PRIVILEGES.some((k) => eff[k] === true);
  return next;
}

/* One hue per capability area, so a role's shape is legible before reading a
 * single label: chat is sky, tickets jade, reporting violet, administration
 * red — the same ranking the catalogue itself implies. */
const GROUP_CHIPS: Record<string, string> = {
  chat: 'bg-sky-tint text-sky',
  customers: 'bg-sky-tint text-sky',
  tickets: 'bg-primary-tint text-primary',
  lateOrders: 'bg-primary-tint text-primary',
  coupons: 'bg-violet-tint text-violet',
  reporting: 'bg-violet-tint text-violet',
  admin: 'bg-destructive-tint text-destructive',
};

interface AppRole {
  id: string;
  name: string;
  description: string | null;
  privileges: Record<string, boolean> | null;
  brands: string[] | null;
  stores: string[] | null;
  directus_role: string | null;
  builtin: boolean;
}
interface BrandRow {
  id: string;
  name: string;
}
interface StoreRow {
  id: string;
  name: string;
  brand: string | null;
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
              'stores',
              'directus_role',
              'builtin',
            ],
          } as never,
        ),
      )) as unknown as AppRole[],
  });

const useStores = () =>
  useQuery({
    queryKey: ['stores-for-roles'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'stores' as never,
          { limit: -1, sort: ['name'], fields: ['id', 'name', 'brand'] } as never,
        ),
      )) as unknown as StoreRow[],
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
  /** Branch fence. Empty = every branch the brands allow. */
  stores: string[];
}
const EMPTY: Draft = {
  id: null,
  name: '',
  description: '',
  privileges: {},
  brands: [],
  stores: [],
};

export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const roles = useAppRoles();
  const brands = useBrands();
  const stores = useStores();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const nameRef = useRef<HTMLInputElement>(null);

  /**
   * Creating is a MODE, not the absence of a selection.
   *
   * Without it "New role" only cleared a form that was usually already clear,
   * so the click looked like it did nothing, and the button that actually
   * created the role sat at the far bottom of a long privilege matrix — the
   * admin ticked what they wanted, then had to go looking for Create.
   *
   * Now the toolbar button IS the action: it opens the draft, then turns into
   * "Create role" and creates it. One primary action, always in the same
   * place, saying what it will do.
   */
  const [creating, setCreating] = useState(false);
  const startNewRole = () => {
    setDraft(EMPTY);
    setCreating(true);
    requestAnimationFrame(() => nameRef.current?.focus());
  };

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
  const { isOwner: ownerEditing } = useAuth();
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        name: d.name.trim(),
        description: d.description.trim() || null,
        privileges: ownerEditing ? ownerSaveShape(d.privileges, d.name) : d.privileges,
        brands: d.brands.length ? d.brands : null,
        stores: d.stores.length ? d.stores : null,
      };
      return d.id
        ? directus.request(updateItem('app_roles' as never, d.id, body as never))
        : directus.request(createItem('app_roles' as never, body as never));
    },
    onSuccess: (created: unknown) => {
      invalidate();
      const id = (created as { id?: string })?.id ?? draft.id;
      if (id) setDraft((d) => ({ ...d, id }));
      // The draft is a real role now, so the toolbar goes back to offering a
      // NEW one rather than continuing to say "Create".
      setCreating(false);
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
      setCreating(false);
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
      stores: [...(selected.stores ?? [])],
    });
  }, [selected]);

  const GROUP_ICONS: Record<string, React.ReactNode> = {
    chat: <InboxIcon size={15} />,
    customers: <InboxIcon size={15} />,
    tickets: <TicketIcon size={15} />,
    lateOrders: <TicketIcon size={15} />,
    coupons: <TicketIcon size={15} />,
    reporting: <ChartIcon size={15} />,
    admin: <ShieldIcon size={15} />,
  };
  const { can, isOwner, user } = useAuth();
  /**
   * Two locks, one editor.
   *
   * A built-in row is defined in code. And the row that materialized to the
   * role YOU are signed in with is locked for everyone but the owner: a person
   * who can edit their own role can grant themselves whatever the ceiling
   * allows, one tick at a time. The server refuses it too (app-roles-sync);
   * this just says so before the click.
   */
  const ownRole =
    !isOwner && !!selected?.directus_role && selected.directus_role === user?.role?.id;
  const locked = (selected?.builtin ?? false) || ownRole;
  /**
   * THE CEILING. A privilege you do not hold is one you cannot grant — shown,
   * so the shape of the whole catalogue stays visible, but not tickable. The
   * owner (Directus admin_access) is unrestricted. Enforced again server-side,
   * because a disabled toggle is a courtesy and a PATCH is not.
   */
  const grantable = (key: Privilege) => isOwner || can(key);
  const PRIVS = isOwner ? OWNER_PRIVS : SHARED_PRIVS;
  /* What a switch SHOWS: the stored value, or - for a fine-grained permission
     nobody has set - its default, which is what the role can do right now. */
  const shown = useMemo(
    () => effectivePrivileges(draft.privileges, draft.name),
    [draft.privileges, draft.name],
  );
  /**
   * Which branches are offered. Fencing to a brand already implies its
   * branches, so once brands are picked the branch list narrows to them —
   * offering all 122 under a brand with two is how a picker stops helping.
   */
  const branchChoices = useMemo(() => {
    const all = stores.data ?? [];
    const inScope =
      draft.brands.length > 0 ? all.filter((s) => s.brand && draft.brands.includes(s.brand)) : all;
    /*
     * Always "{brand} - {branch}", at the owner's request.
     *
     * It used to qualify only the AMBIGUOUS names, on the theory that
     * suffixing every one made the common case noisier to fix the rare one.
     * That was wrong about how the list is read: somebody fencing a role scans
     * for their BRAND first and the branch second, so putting the brand last —
     * and only sometimes — meant re-reading every line to find the group they
     * were looking for. Brand first also sorts the list into brand blocks for
     * free.
     */
    const brandName = new Map((brands.data ?? []).map((b) => [b.id, b.name]));
    return inScope
      .map((s) => {
        const brand = s.brand ? (brandName.get(s.brand) ?? '') : '';
        return { ...s, label: brand ? `${brand} - ${s.name}` : s.name };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [stores.data, draft.brands, brands.data]);
  const GROUPS: Record<string, string> = {
    chat: t('roles.groupChat', { defaultValue: 'Customer chat' }),
    customers: t('roles.groupCustomers', { defaultValue: 'Customers' }),
    tickets: t('roles.groupTickets', { defaultValue: 'Tickets' }),
    lateOrders: t('roles.groupLateOrders', { defaultValue: 'Late orders' }),
    coupons: t('roles.groupCoupons', { defaultValue: 'Coupons & compensation' }),
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
    view_agent_dashboard: t('roles.p.viewAgentDashboard', { defaultValue: 'View agent dashboard' }),
    export_data: t('roles.p.exportData', { defaultValue: 'Export to Excel/CSV' }),
    import_data: t('roles.p.importData', { defaultValue: 'Import tickets' }),
    manage_lists: t('roles.p.manageLists', { defaultValue: 'Edit dropdown lists & settings' }),
    manage_restaurants: t('roles.p.manageRestaurants', {
      defaultValue: 'Manage brands & branches',
    }),
    manage_users: t('roles.p.manageUsers', { defaultValue: 'Manage users' }),
    view_ops_dashboard: t('roles.p.viewOpsDashboard', {
      defaultValue: 'View operations dashboard',
    }),
    schedule_reports: t('roles.p.scheduleReports', { defaultValue: 'Schedule reports' }),
    manage_sla: t('roles.p.manageSla', { defaultValue: 'Edit SLA policies' }),
    manage_roles: t('roles.p.manageRoles', { defaultValue: 'Manage roles & privileges' }),
    manage_backup: t('roles.p.manageBackup', { defaultValue: 'Run backups' }),
    use_directus_app: t('roles.p.useDirectusApp', {
      defaultValue: 'Use the Directus admin app',
    }),
    // the Administrator's fine-grained permissions
    start_chats: t('roles.p.startChats', { defaultValue: 'Start a chat with a customer' }),
    assign_chats: t('roles.p.assignChats', {
      defaultValue: 'Assign or transfer a chat to an agent or team',
    }),
    close_chats: t('roles.p.closeChats', { defaultValue: 'Close or reopen a chat' }),
    bulk_edit_chats: t('roles.p.bulkEditChats', {
      defaultValue: 'Bulk actions on chats (status, tags)',
    }),
    delete_chats: t('roles.p.deleteChats', { defaultValue: 'Delete chats' }),
    edit_own_messages: t('roles.p.editOwnMessages', {
      defaultValue: 'Edit or delete own messages (15 min)',
    }),
    receive_chats: t('roles.p.receiveChats', {
      defaultValue: 'Show as online and receive auto-assigned chats',
    }),
    can_be_assigned: t('roles.p.canBeAssigned', {
      defaultValue: 'Can be assigned chats (by routing or by hand)',
    }),
    view_chat_status_report: t('roles.p.viewChatStatusReport', {
      defaultValue: 'View the Chat status report',
    }),
    view_busy_report: t('roles.p.viewBusyReport', { defaultValue: 'View the Busy time report' }),
    view_chat_breakdown: t('roles.p.viewChatBreakdown', {
      defaultValue: 'See the Chat by chat table on Agent performance',
    }),
    view_own_performance: t('roles.p.viewOwnPerformance', {
      defaultValue: 'Agent portal: Agent performance page',
    }),
    view_data_warnings: t('roles.p.viewDataWarnings', {
      defaultValue: 'See data-quality notices on reports (unmapped stores, missing details)',
    }),
    view_preferences: t('roles.p.viewPreferences', {
      defaultValue: 'Agent portal: Preferences page',
    }),
    mark_busy: t('roles.p.markBusy', {
      defaultValue: 'Show the Busy button in the agent portal (busy time is recorded)',
    }),
    no_agents_alert: t('roles.p.noAgentsAlert', {
      defaultValue: 'Receive the "no agents available" alert',
    }),
    view_contacts: t('roles.p.viewContacts', { defaultValue: 'Open the Customers page' }),
    create_contacts: t('roles.p.createContacts', { defaultValue: 'Add a new customer' }),
    edit_contacts: t('roles.p.editContacts', { defaultValue: 'Edit a customer and their tags' }),
    export_contacts: t('roles.p.exportContacts', { defaultValue: 'Export customers' }),
    view_ticket_history: t('roles.p.viewTicketHistory', {
      defaultValue: 'See ticket change history',
    }),
    export_ticket_excel: t('roles.p.exportTicketExcel', {
      defaultValue: 'Export a ticket to Excel',
    }),
    work_late_orders: t('roles.p.workLateOrders', {
      defaultValue: 'Work late orders (handle, ignore, comment)',
    }),
    view_late_orders_report: t('roles.p.viewLateOrdersReport', {
      defaultValue: 'View late orders report',
    }),
    export_late_orders: t('roles.p.exportLateOrders', {
      defaultValue: 'Export the late-orders report',
    }),
    view_order_details: t('roles.p.viewOrderDetails', {
      defaultValue: 'See the order details panel',
    }),
    request_coupons: t('roles.p.requestCoupons', { defaultValue: 'Request a coupon' }),
    view_coupon_spend: t('roles.p.viewCouponSpend', { defaultValue: 'See coupon spend amounts' }),
    view_compensation_reports: t('roles.p.viewCompensationReports', {
      defaultValue: 'View the compensation and coupon reports',
    }),
    delete_compensation: t('roles.p.deleteCompensation', {
      defaultValue: 'Delete a compensation record',
    }),
    manage_ticket_compensation: t('roles.p.manageTicketCompensation', {
      defaultValue:
        "Manage a ticket's compensation (assign a coupon; Not Compensated removes it, also from the customer's Yiji app)",
    }),
    view_agent_reports: t('roles.p.viewAgentReports', {
      defaultValue:
        'View agent summary reports (Agent summary, Chat status, Busy time, Agent performance)',
    }),
    view_sla_report: t('roles.p.viewSlaReport', { defaultValue: 'View ticket deadline report' }),
    delete_users: t('roles.p.deleteUsers', { defaultValue: 'Delete users' }),
    view_coupon_queue: t('roles.p.viewCouponQueue', {
      defaultValue: 'See the Compensation page (read-only without Request coupons)',
    }),
    view_coupon_approvals: t('roles.p.viewCouponApprovals', {
      defaultValue: 'See Coupon approvals (read-only without Approve coupons)',
    }),
    delete_restaurants: t('roles.p.deleteRestaurants', {
      defaultValue: 'Delete restaurants (stores and brands)',
    }),
    manage_teams: t('roles.p.manageTeams', { defaultValue: 'Manage teams' }),
    edit_yiji_branch_id: t('roles.p.editYijiBranchId', {
      defaultValue: "Edit a branch's Yiji restaurant ID",
    }),
    manage_store_notifications: t('roles.p.manageStoreNotifications', {
      defaultValue: 'Branch notifications',
    }),
    manage_notification_defaults: t('roles.p.manageNotificationDefaults', {
      defaultValue: 'Organisation-wide notification defaults',
    }),
  };

  return (
    <div className="flex h-full flex-col">
      {/* The Rapport header (owner, 2026-10-22): title, what a role is under
          it, the one primary action on the far side. */}
      <PageHeader
        title={t('roles.title', { defaultValue: 'Roles & privileges' })}
        description={t('roles.heroSubtitle', {
          defaultValue:
            'Named sets of ticked privileges, optionally fenced to specific brands. Pick a role to see or change what it can do.',
        })}
        actions={
          <>
            {/* One primary action, always in this spot, named after what it does:
                it opens a draft, becomes Create while that draft is unsaved, and
                becomes Save once the role exists. A built-in role is code-defined,
                so there is nothing to save and the button offers a new one. */}
            {creating ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreating(false);
                    setDraft(EMPTY);
                  }}
                >
                  {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                </Button>
                <Button
                  size="sm"
                  onClick={() => save.mutate(draft)}
                  disabled={!draft.name.trim() || save.isPending}
                  loading={save.isPending}
                >
                  {t('roles.create', { defaultValue: 'Create role' })}
                </Button>
              </>
            ) : draft.id && !locked ? (
              <>
                <Button size="sm" variant="ghost" onClick={startNewRole} iconStart={<PlusIcon />}>
                  {t('roles.new', { defaultValue: 'New role' })}
                </Button>
                <Button
                  size="sm"
                  onClick={() => save.mutate(draft)}
                  disabled={!draft.name.trim() || save.isPending}
                  loading={save.isPending}
                >
                  {t('roles.save', { defaultValue: 'Save role' })}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={startNewRole} iconStart={<PlusIcon />}>
                {t('roles.new', { defaultValue: 'New role' })}
              </Button>
            )}
          </>
        }
      />

      {/* Scroll lives on the page wrapper. The grid runs the header's full
          width on its gutter (Rapport skin) - the list beside the editor at
          desktop width, stacked on a phone.

          ONE GRID, ONE RHYTHM (owner, 2026-10-25: "the boxes and cards are not
          positioned uniformly"). The privilege areas used to be separate cards
          in a 2- or 4-column grid, so a twelve-switch area sat beside a
          four-switch one and each row of cards ended at a different height.
          Now every area is a full-width band inside ONE card per portal: the
          area's name and meter on the start side, its switches in even columns
          on the other. Every band is the same width, every switch row the same
          width, and the gaps between blocks are the same 1.25rem everywhere. */}
      <div className={PAGE_BODY}>
        <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          {/* ── the roles ── */}
          <div className="lg:sticky lg:top-0">
            {roles.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : (
              /* Clean board list — rows flush inside one card, hairline
               separators, quiet hover; the selected row is tinted. */
              <div className={cn(SECTION_CARD, 'overflow-hidden')}>
                <div className="flex min-h-12 items-center justify-between gap-2 border-b border-foreground/[0.07] px-4 py-2.5">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    {t('roles.listTitle', { defaultValue: 'Roles' })}
                    <span className="ms-2 text-xs font-medium tabular-nums text-muted-foreground">
                      {(roles.data ?? []).length}
                    </span>
                  </h2>
                  {/* Nothing could clear a selection once made, so a built-in
                      role's read-only panel became a dead end. Always shown;
                      usable only while a role is selected (owner, 2026-10-22:
                      a usable Clear must look usable). */}
                  <ClearFiltersButton
                    active={!!draft.id}
                    onClear={() => {
                      setCreating(false);
                      setDraft(EMPTY);
                    }}
                    label={t('roles.clearSelection', { defaultValue: 'Clear' })}
                  />
                </div>
                <ul className="divide-y divide-foreground/[0.06]">
                  {(roles.data ?? []).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        data-role-row=""
                        aria-current={draft.id === r.id ? 'true' : undefined}
                        onClick={() => {
                          // Opening an existing role ends the draft — otherwise
                          // the toolbar keeps offering to "Create" a role that
                          // already exists.
                          setCreating(false);
                          setDraft((d) => ({ ...d, id: r.id }));
                        }}
                        className={cn(
                          'flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start transition-colors duration-fast',
                          'focus-visible:outline-none focus-visible:bg-foreground/[0.05]',
                          draft.id === r.id
                            ? 'bg-primary/10 ring-1 ring-inset ring-primary/30'
                            : 'hover:bg-foreground/[0.03]',
                        )}
                      >
                        <RoleMonogram name={r.name} builtin={r.builtin} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-foreground">
                            {r.name}
                          </span>
                          {/* Permission count under the name, as quiet text. */}
                          <span className="mt-0.5 block text-2xs leading-snug tabular-nums text-muted-foreground">
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
                        </span>
                        <RoleStatus role={r} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* ── the editor ── */}
          <div className="min-w-0 space-y-5">
            {locked ? (
              <div className={cn(SECTION_CARD, 'p-5 sm:p-6')}>
                <div className="flex items-center gap-3">
                  {selected && <RoleMonogram name={selected.name} builtin={selected.builtin} />}
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-foreground">
                    {selected?.name}
                  </h2>
                  {selected && <RoleStatus role={selected} />}
                </div>
                {/* The WHOLE description, line breaks kept (owner, 2026-10-25:
                    a multi-line description showed one line). */}
                {selected?.description?.trim() && (
                  <p
                    dir="auto"
                    className="mt-3 max-w-[70ch] whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
                  >
                    {selected.description}
                  </p>
                )}
                <p className="mt-4 max-w-[70ch] rounded-xl bg-secondary/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  {t('roles.builtinHelp', {
                    defaultValue:
                      'Built-in roles are defined in code, where their security hardening lives, and cannot be edited here. Create a new role for anything these two do not cover.',
                  })}
                </p>
              </div>
            ) : (
              <>
                {/* Role details: name and description side by side, tops
                    aligned. The description GROWS with its text - it was a
                    one-row box, so a multi-line description showed one line
                    (owner, 2026-10-25). */}
                <div className={cn(SECTION_CARD, 'p-5 sm:p-6')}>
                  <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <label className="flex flex-col gap-1.5">
                      <span className={FIELD_LABEL}>
                        {t('roles.name', { defaultValue: 'Role name' })}
                      </span>
                      <Input
                        ref={nameRef}
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        placeholder={t('roles.namePlaceholder', {
                          defaultValue: 'e.g. Brand Supervisor',
                        })}
                      />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className={FIELD_LABEL}>
                        {t('roles.description', { defaultValue: 'Description' })}
                      </span>
                      <Textarea
                        rows={3}
                        dir="auto"
                        value={draft.description}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                        className="min-h-[4.75rem] max-h-80 resize-y [field-sizing:content]"
                      />
                    </label>
                  </div>
                </div>

                {/* TWO PARTS (owner, 2026-10-15): what this role may do in the
                    AGENT portal, then in the ADMIN portal. */}
                {(['agent', 'admin'] as const).map((portal) => {
                  const areas = Object.entries(GROUPS)
                    .map(([group, label]) => ({
                      group,
                      label,
                      privs: PRIVS.filter(
                        (p) => p.group === group && PRIVILEGE_PORTAL[p.key] === portal,
                      ),
                    }))
                    // Customers, late orders and coupons hold only the
                    // Administrator's switches; nobody else sees those areas.
                    .filter((a) => a.privs.length > 0);
                  if (areas.length === 0) return null;
                  const portalTotal = areas.reduce((n, a) => n + a.privs.length, 0);
                  const portalOn = areas.reduce(
                    (n, a) => n + a.privs.filter((p) => !!shown[p.key]).length,
                    0,
                  );
                  return (
                    <section key={portal} className={cn(SECTION_CARD, 'overflow-hidden')}>
                      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-foreground/[0.07] px-5 py-3 sm:px-6">
                        <h3 className="text-sm font-semibold tracking-tight text-foreground">
                          {portal === 'agent'
                            ? t('roles.portalAgent', { defaultValue: 'Agent portal' })
                            : t('roles.portalAdmin', { defaultValue: 'Admin portal' })}
                        </h3>
                        <span className="text-xs font-medium tabular-nums text-muted-foreground">
                          {portalOn}/{portalTotal}
                        </span>
                      </header>
                      <div className="divide-y divide-foreground/[0.06]">
                        {areas.map(({ group, label, privs: groupPrivs }) => {
                          const ticked = groupPrivs.filter((p) => !!shown[p.key]).length;
                          return (
                            <fieldset
                              key={`${portal}-${group}`}
                              className="grid gap-x-6 gap-y-3 px-5 py-4 sm:px-6 xl:grid-cols-[13rem_minmax(0,1fr)]"
                            >
                              <legend className="sr-only">{label}</legend>
                              {/* The area: tinted glyph, name, how much of it
                                  this role holds, and the all/none shortcut. */}
                              <div className="min-w-0 xl:pt-1.5">
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
                                  <span className="min-w-0 flex-1 text-sm font-semibold leading-snug tracking-tight text-foreground">
                                    {label}
                                  </span>
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
                                  {/* Granting a whole area is the common case;
                                      ticking seven switches one at a time was
                                      busywork. */}
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
                                    className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-semibold text-primary transition-colors duration-fast hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    {ticked === groupPrivs.length
                                      ? t('roles.clearGroup', { defaultValue: 'None' })
                                      : t('roles.allGroup', { defaultValue: 'All' })}
                                  </button>
                                </div>
                              </div>
                              {/* Even columns of identical switch rows. */}
                              <ul className="grid gap-x-4 gap-y-0.5 md:grid-cols-2 2xl:grid-cols-3">
                                {groupPrivs.map((p) => (
                                  <li key={p.key} className="min-w-0">
                                    {/*
                                  A privilege you cannot grant is DISABLED, and a
                                  disabled switch is silent: clicking it does
                                  nothing and says nothing, which reads as a bug
                                  rather than a rule. Only `Operations` held
                                  `view_ops_dashboard`, so every role editor in
                                  the system found that one switch inert and had
                                  no way to learn why (owner, 2026-09-24).

                                  The ceiling stays exactly as it was — this only
                                  makes it legible: the row dims, the reason is
                                  printed beside the label instead of hidden in a
                                  hover title, and the cursor stops promising a
                                  click. The thumb moves via the logical inset so
                                  RTL slides the right way.
                                */}
                                    <label
                                      className={cn(
                                        'flex h-full min-h-11 items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors duration-fast',
                                        locked || !grantable(p.key)
                                          ? 'cursor-not-allowed opacity-60'
                                          : 'cursor-pointer hover:bg-foreground/[0.03]',
                                      )}
                                    >
                                      <span className="min-w-0 flex-1 leading-snug">
                                        {PRIV_LABELS[p.key]}
                                        {isOwnerPrivilege(p.key) && (
                                          <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">
                                            {t('roles.ownerOnlyHint', {
                                              defaultValue:
                                                'Only the Administrator sees this switch.',
                                            })}
                                          </span>
                                        )}
                                        {!locked && !grantable(p.key) && (
                                          <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">
                                            {t('roles.ceilingHint', {
                                              defaultValue:
                                                'You cannot grant a privilege your own role does not hold.',
                                            })}
                                          </span>
                                        )}
                                      </span>
                                      <span className="relative inline-flex shrink-0">
                                        <input
                                          type="checkbox"
                                          className="peer sr-only"
                                          checked={!!shown[p.key]}
                                          disabled={locked || !grantable(p.key)}
                                          title={
                                            !grantable(p.key)
                                              ? t('roles.ceilingHint', {
                                                  defaultValue:
                                                    'You cannot grant a privilege your own role does not hold.',
                                                })
                                              : undefined
                                          }
                                          onChange={(e) =>
                                            setDraft((d) => ({
                                              ...d,
                                              privileges: {
                                                ...d.privileges,
                                                [p.key]: e.target.checked,
                                              },
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
                    </section>
                  );
                })}

                {/* Brand and branch fences, side by side at desktop width and
                    stretched to the same height, so the pair ends on one line. */}
                <div className="grid items-stretch gap-5 xl:grid-cols-2">
                  {/* brand restriction — the shared SectionCard surface */}
                  <SectionCard
                    className="h-full"
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
                                brands: on
                                  ? d.brands.filter((x) => x !== b.id)
                                  : [...d.brands, b.id],
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

                  {/* Branch restriction — one level below brand, for the manager
                      who owns specific restaurants rather than a whole chain. */}
                  <SectionCard
                    className="h-full"
                    title={t('roles.branches', { defaultValue: 'Branch access' })}
                    hint={t('roles.branchesHelp', {
                      defaultValue:
                        'For a role that owns particular restaurants rather than a whole brand — an area manager. Nothing ticked means every branch the brands above allow. Ticking both narrows to the intersection, and a ticket not yet linked to a branch stays visible either way.',
                    })}
                  >
                    {branchChoices.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t('roles.branchesPickBrand', {
                          defaultValue: 'No branches to choose from yet.',
                        })}
                      </p>
                    ) : (
                      /* A SEARCH, not 122 chips. See BranchPicker for why the
                         chosen set and the searchable set are separated. */
                      <BranchPicker
                        options={branchChoices}
                        selected={draft.stores}
                        onChange={(stores) => setDraft((d) => ({ ...d, stores }))}
                      />
                    )}
                  </SectionCard>
                </div>

                {/* Only the DESTRUCTIVE action lives down here. Save/Create moved
                    to the toolbar: two buttons that both created a role, one of
                    them below a fifteen-row privilege matrix, is how an admin
                    ends up unsure whether their work was kept. Delete stays far
                    from the primary action on purpose. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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

/** The two-letter tile beside a role's name: tinted for an editable role. */
function RoleMonogram({ name, builtin }: { name: string; builtin: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-xl text-2xs font-bold uppercase',
        builtin ? 'bg-secondary text-muted-foreground' : 'bg-primary-tint text-primary',
      )}
    >
      {name.slice(0, 2)}
    </span>
  );
}

/** Built-in / Active / Applying, the same pill in the list and the editor. */
function RoleStatus({ role }: { role: Pick<AppRole, 'builtin' | 'directus_role'> }) {
  const { t } = useTranslation();
  if (role.builtin)
    return (
      <Pill tone="neutral" size="sm">
        {t('roles.builtin', { defaultValue: 'Built-in' })}
      </Pill>
    );
  return role.directus_role ? (
    <Pill tone="success" size="sm">
      {t('roles.active', { defaultValue: 'Active' })}
    </Pill>
  ) : (
    <Pill tone="warning" size="sm">
      {t('roles.pending', { defaultValue: 'Applying…' })}
    </Pill>
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
