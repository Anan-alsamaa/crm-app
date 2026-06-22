import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  ConfirmDialog,
  Drawer,
  DrawerSection,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Pill,
  SelectMenu,
  Skeleton,
  Textarea,
  toast,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  useAutomationRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  type AutomationRule,
  type AutomationRuleInput,
  type RuleAction,
  type RuleCondition,
  type TriggerEvent,
} from './api.js';

/**
 * Admin automation rule management.
 *
 * Soft-card list, drawer-based create/edit. Conditions + actions are
 * structured repeater rows so admins don't need to hand-author JSON.
 * Both shapes also accept a JSON-paste fallback for power users (the
 * worker accepts whatever shape Directus stores).
 */

const TRIGGERS: TriggerEvent[] = [
  'conversation_created',
  'message_received',
  'ticket_created',
  'ticket_status_changed',
  'sla_warning',
  'sla_breach',
  'inactivity',
  'keyword_matched',
];

const OPS: RuleCondition['op'][] = ['eq', 'neq', 'contains', 'starts_with', 'gt', 'lt', 'in'];
const ACTION_KINDS: RuleAction['kind'][] = [
  'assign_team',
  'assign_agent',
  'set_priority',
  'set_status',
  'add_tag',
  'send_notification',
  'escalate',
];

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

interface DraftRule {
  name: string;
  description: string;
  trigger_event: TriggerEvent;
  conditions: RuleCondition[];
  actions: RuleAction[];
  active: boolean;
  priority: number;
}

const blankRule = (): DraftRule => ({
  name: '',
  description: '',
  trigger_event: 'message_received',
  conditions: [],
  actions: [{ kind: 'send_notification', params: { recipientId: '', title: '' } }],
  active: true,
  priority: 0,
});

export function AutomationPage() {
  const { t } = useTranslation();
  const rules = useAutomationRules();
  const create = useCreateRule();
  const update = useUpdateRule();
  const remove = useDeleteRule();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRule>(blankRule());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const onDelete = async (): Promise<void> => {
    if (!deletingId) return;
    try {
      await remove.mutateAsync(deletingId);
      toast.success(t('automation.deleted', { defaultValue: 'Rule deleted.' }));
      setDeletingId(null);
    } catch {
      toast.error(t('automation.deleteError', { defaultValue: 'Could not delete rule.' }));
    }
  };

  useEffect(() => {
    if (!drawerOpen) return;
    if (editingId) {
      const existing = rules.data?.find((r) => r.id === editingId);
      if (existing) {
        setDraft({
          name: existing.name,
          description: existing.description ?? '',
          trigger_event: existing.trigger_event,
          conditions: existing.conditions ?? [],
          actions: existing.actions ?? [],
          active: existing.active,
          priority: existing.priority,
        });
      }
    } else {
      setDraft(blankRule());
    }
  }, [drawerOpen, editingId, rules.data]);

  const onSubmit = async (): Promise<void> => {
    if (!draft.name.trim()) {
      toast.error(t('automation.nameRequired', { defaultValue: 'Name is required.' }));
      return;
    }
    const payload: AutomationRuleInput = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      trigger_event: draft.trigger_event,
      conditions: draft.conditions,
      actions: draft.actions,
      active: draft.active,
      priority: draft.priority,
    };
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, patch: payload });
        toast.success(t('automation.updated', { defaultValue: 'Rule updated.' }));
      } else {
        await create.mutateAsync(payload);
        toast.success(t('automation.created', { defaultValue: 'Rule created.' }));
      }
      setDrawerOpen(false);
      setEditingId(null);
    } catch {
      toast.error(t('automation.saveError', { defaultValue: 'Could not save rule.' }));
    }
  };

  const total = rules.data?.length ?? 0;
  const activeCount = (rules.data ?? []).filter((r) => r.active).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('automation.title', { defaultValue: 'Automation' })}
        </h1>
        <span className="hidden text-xs text-muted-foreground sm:inline-flex items-center gap-2.5">
          <span className="opacity-50">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{total}</strong>{' '}
            {t('automation.rules', { defaultValue: 'rules' })}
          </span>
          <span className="opacity-30">·</span>
          <span className="tabular-nums">
            <strong className="font-semibold text-foreground">{activeCount}</strong>{' '}
            {t('automation.active', { defaultValue: 'active' })}
          </span>
        </span>
        <ToolbarSpacer />
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditingId(null);
            setDrawerOpen(true);
          }}
          iconStart={<PlusIcon />}
        >
          {t('automation.create', { defaultValue: 'New rule' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-3">
        {rules.isError ? (
          <ErrorState
            title={t('automation.loadError', { defaultValue: 'Could not load automation rules' })}
            message={t('automation.loadErrorHint', {
              defaultValue: 'Check your connection and try again.',
            })}
            retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
            onRetry={() => void rules.refetch()}
          />
        ) : rules.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-2xl" />
            ))}
          </div>
        ) : !rules.data || rules.data.length === 0 ? (
          <EmptyState
            title={t('automation.empty', { defaultValue: 'No automation rules yet.' })}
            description={t('automation.emptyHint', {
              defaultValue:
                'Rules fire when triggers match — e.g. auto-assign high-priority tickets, notify a team on SLA breach.',
            })}
            action={
              <Button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDrawerOpen(true);
                }}
                iconStart={<PlusIcon />}
              >
                {t('automation.create', { defaultValue: 'New rule' })}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {rules.data.map((r) => (
              <li key={r.id}>
                <RuleCard
                  rule={r}
                  onEdit={() => {
                    setEditingId(r.id);
                    setDrawerOpen(true);
                  }}
                  onToggle={async () => {
                    await update.mutateAsync({ id: r.id, patch: { active: !r.active } });
                  }}
                  onDelete={() => setDeletingId(r.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingId(null);
        }}
        width="lg"
        title={
          editingId
            ? t('automation.edit', { defaultValue: 'Edit rule' })
            : t('automation.create', { defaultValue: 'New rule' })
        }
        description={t('automation.drawerHint', {
          defaultValue:
            'Conditions are AND-joined; if all match, actions run in order. Conditions on `context.<field>` reference the trigger payload.',
        })}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDrawerOpen(false);
                setEditingId(null);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="button" onClick={onSubmit} loading={create.isPending || update.isPending}>
              {t('actions.save', { ns: 'common' })}
            </Button>
          </>
        }
      >
        <div className="space-y-6">
          <DrawerSection
            title={t('automation.sectionMeta', { defaultValue: 'Rule' })}
            description={t('automation.sectionMetaHint', {
              defaultValue: 'Higher priority rules run first within the same trigger.',
            })}
          >
            <FormField label={t('automation.name', { defaultValue: 'Name' })}>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </FormField>
            <FormField label={t('automation.description', { defaultValue: 'Description' })}>
              <Textarea
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label={t('automation.trigger', { defaultValue: 'Trigger' })}>
                <SelectMenu
                  fullWidth
                  value={draft.trigger_event}
                  onChange={(v) => setDraft({ ...draft, trigger_event: v as TriggerEvent })}
                  aria-label={t('automation.trigger', { defaultValue: 'Trigger' })}
                  options={TRIGGERS.map((trg) => ({ value: trg, label: trg }))}
                />
              </FormField>
              <FormField label={t('automation.priority', { defaultValue: 'Priority' })}>
                <Input
                  type="number"
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft({ ...draft, priority: Number.parseInt(e.target.value, 10) || 0 })
                  }
                />
              </FormField>
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('automation.sectionConditions', { defaultValue: 'Conditions' })}
            description={t('automation.sectionConditionsHint', {
              defaultValue:
                'All conditions must match. Reference fields with dot paths (e.g. context.priority).',
            })}
          >
            <ConditionsEditor
              conditions={draft.conditions}
              onChange={(conditions) => setDraft({ ...draft, conditions })}
            />
          </DrawerSection>

          <DrawerSection
            title={t('automation.sectionActions', { defaultValue: 'Actions' })}
            description={t('automation.sectionActionsHint', {
              defaultValue: 'Actions run in order. Params are stored as JSON on the rule.',
            })}
          >
            <ActionsEditor
              actions={draft.actions}
              onChange={(actions) => setDraft({ ...draft, actions })}
            />
          </DrawerSection>

          <DrawerSection
            title={t('automation.sectionStatus', { defaultValue: 'Status' })}
            description={t('automation.sectionStatusHint', {
              defaultValue: 'Inactive rules are stored but never fire.',
            })}
          >
            <div className="flex gap-1">
              {(['active', 'inactive'] as const).map((s) => {
                const checked = draft.active === (s === 'active');
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDraft({ ...draft, active: s === 'active' })}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 h-8 text-xs font-medium transition-colors duration-fast ease-out',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      checked
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary/60 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(`automation.${s}`, { defaultValue: s })}
                  </button>
                );
              })}
            </div>
          </DrawerSection>
        </div>
      </Drawer>

      <ConfirmDialog
        open={deletingId !== null}
        destructive
        title={t('automation.confirmDelete', { defaultValue: 'Delete this rule?' })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
        loading={remove.isPending}
        onConfirm={() => void onDelete()}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  );
}

function RuleCard({
  rule,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: AutomationRule;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'group flex items-start gap-4 rounded-2xl bg-card/70 px-5 py-4 text-start',
        'shadow-sm shadow-foreground/[0.04] ring-1 ring-foreground/[0.04]',
        'transition-[box-shadow,transform,background-color] duration-fast ease-out',
        'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.08]',
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-foreground truncate">
            {rule.name}
          </h3>
          {!rule.active && (
            <span className="inline-flex items-center rounded-full bg-warning/20 px-2 py-0.5 text-2xs font-medium text-warning-foreground">
              {t('automation.inactive', { defaultValue: 'inactive' })}
            </span>
          )}
        </div>
        {rule.description && (
          <p className="line-clamp-1 text-xs text-muted-foreground">{rule.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <Pill tone="primary" size="sm">
            {rule.trigger_event}
          </Pill>
          <span className="text-2xs text-muted-foreground tabular-nums">
            {rule.conditions?.length ?? 0} {t('automation.cond', { defaultValue: 'cond' })} ·{' '}
            {rule.actions?.length ?? 0} {t('automation.act', { defaultValue: 'act' })} · p=
            {rule.priority}
          </span>
          {(rule.trigger_count ?? 0) > 0 && (
            <span className="text-2xs text-muted-foreground tabular-nums">
              · fired {rule.trigger_count}×
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {rule.active
            ? t('automation.disable', { defaultValue: 'disable' })
            : t('automation.enable', { defaultValue: 'enable' })}
        </button>
        <span className="text-muted-foreground/40">·</span>
        <button
          type="button"
          onClick={onEdit}
          className="text-xs font-semibold text-[oklch(0.42_0.10_196)] underline-offset-2 hover:underline"
        >
          {t('actions.edit', { ns: 'common', defaultValue: 'edit' })}
        </button>
        <span className="text-muted-foreground/40">·</span>
        <button
          type="button"
          onClick={onDelete}
          className="text-2xs font-medium text-destructive underline-offset-2 hover:underline"
        >
          {t('actions.delete', { ns: 'common', defaultValue: 'delete' })}
        </button>
      </div>
    </div>
  );
}

function ConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: RuleCondition[];
  onChange: (next: RuleCondition[]) => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<RuleCondition>) => {
    const next = [...conditions];
    next[i] = { ...next[i]!, ...patch };
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {conditions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('automation.noConditions', {
            defaultValue: 'No conditions — rule fires on every trigger.',
          })}
        </p>
      ) : (
        <ul className="space-y-2">
          {conditions.map((c, i) => (
            <li key={i} className="grid grid-cols-12 gap-2">
              <div className="col-span-5">
                <Input
                  placeholder="context.priority"
                  value={c.field}
                  onChange={(e) => update(i, { field: e.target.value })}
                />
              </div>
              <div className="col-span-3">
                <SelectMenu
                  fullWidth
                  value={c.op}
                  onChange={(v) => update(i, { op: v as RuleCondition['op'] })}
                  aria-label={t('automation.operator', { defaultValue: 'Operator' })}
                  options={OPS.map((op) => ({ value: op, label: op }))}
                />
              </div>
              <div className="col-span-3">
                <Input
                  placeholder="high"
                  value={String(c.value ?? '')}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              </div>
              <div className="col-span-1 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => onChange(conditions.filter((_, j) => j !== i))}
                  className="text-xs text-muted-foreground hover:text-destructive"
                  aria-label={t('actions.remove', { ns: 'common', defaultValue: 'Remove' })}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => onChange([...conditions, { field: 'context.', op: 'eq', value: '' }])}
        className="text-xs text-primary underline-offset-2 hover:underline"
      >
        + {t('automation.addCondition', { defaultValue: 'Add condition' })}
      </button>
    </div>
  );
}

function ActionsEditor({
  actions,
  onChange,
}: {
  actions: RuleAction[];
  onChange: (next: RuleAction[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {actions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('automation.noActions', { defaultValue: 'No actions yet.' })}
        </p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a, i) => (
            <li key={i} className="rounded-xl bg-secondary/40 px-3 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <SelectMenu
                  className="w-44"
                  value={a.kind}
                  onChange={(v) => {
                    const next = [...actions];
                    next[i] = { kind: v as RuleAction['kind'], params: {} };
                    onChange(next);
                  }}
                  aria-label={t('automation.action', { defaultValue: 'Action' })}
                  options={ACTION_KINDS.map((k) => ({ value: k, label: k }))}
                />
                <button
                  type="button"
                  onClick={() => onChange(actions.filter((_, j) => j !== i))}
                  className="ms-auto text-xs text-muted-foreground hover:text-destructive"
                  aria-label={t('actions.remove', { ns: 'common', defaultValue: 'Remove' })}
                >
                  ×
                </button>
              </div>
              <Textarea
                rows={2}
                placeholder='{"recipientId":"...", "title":"..."}'
                value={JSON.stringify(a.params)}
                onChange={(e) => {
                  try {
                    const params = JSON.parse(e.target.value || '{}') as Record<string, unknown>;
                    const next = [...actions];
                    next[i] = { kind: a.kind, params };
                    onChange(next);
                  } catch {
                    /* leave as-is */
                  }
                }}
                className="font-mono text-xs"
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => onChange([...actions, { kind: 'send_notification', params: {} }])}
        className="text-xs text-primary underline-offset-2 hover:underline"
      >
        + {t('automation.addAction', { defaultValue: 'Add action' })}
      </button>
    </div>
  );
}
