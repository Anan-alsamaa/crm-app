import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, readRoles, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { Button, cn, toast } from '@yiji/ui';
import {
  COMPENSATION_ESCALATION_SETTING_KEY,
  COMPENSATION_ESCALATION_TARGETS,
  compensationEscalationRolesValue,
  parseCompensationEscalationRoles,
  COMPENSATION_ESCALATION_ALWAYS_ROLE,
  type CompensationEscalationRoles,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { SECTION_CARD } from '../../components/shell/Page.js';

/**
 * WHO HEARS OF A YIJI V2 COMPENSATION ESCALATION (owner, 18 Nov 2026; design
 * choice 2, to confirm with the owner).
 *
 * V2's policy escalates some cases to "Operations Manager" or "Relevant
 * management" (`compensation.escalated`). The CRM tells every active user of
 * the CRM ROLES mapped here - by role NAME, because resolving by privilege
 * reaches nobody for the built-in Administrator (the recipients trap).
 * Defaults (owner rule, 18 Nov 2026; WeCare Agent -> WeCare Supervisor ->
 * WeCare Admin -> Administrator): "Operations Manager" -> WeCare Supervisor,
 * "Relevant management" -> WeCare Admin. The Administrator ALWAYS receives
 * every escalation: shown ticked and locked. The Administrator alone edits it.
 */
const KEY = ['app-settings', COMPENSATION_ESCALATION_SETTING_KEY] as const;
const SERVICE_ROLE = /^svc-/i;

export function CompensationEscalationCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isOwner } = useAuth();
  const setting = useQuery({
    queryKey: KEY,
    enabled: isOwner,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'app_settings' as never,
          {
            filter: { key: { _eq: COMPENSATION_ESCALATION_SETTING_KEY } },
            fields: ['id', 'value'],
            limit: 1,
          } as never,
        ),
      )) as unknown as Array<{ id: string; value: unknown }>;
      const row = rows[0] ?? null;
      return { rowId: row?.id ?? null, mapping: parseCompensationEscalationRoles(row?.value) };
    },
  });
  const roleNames = useQuery({
    queryKey: ['directus-role-names'],
    enabled: isOwner,
    queryFn: async () =>
      (
        (await directus.request(readRoles({ fields: ['name'], limit: -1 }) as never)) as Array<{
          name: string;
        }>
      )
        .map((r) => r.name)
        .filter((n) => n && !SERVICE_ROLE.test(n))
        .sort((a, b) => a.localeCompare(b)),
  });
  const [draft, setDraft] = useState<CompensationEscalationRoles | null>(null);
  useEffect(() => {
    if (setting.data) setDraft(setting.data.mapping);
  }, [setting.data]);

  const save = useMutation({
    mutationFn: async (m: CompensationEscalationRoles) => {
      const value = compensationEscalationRolesValue(m);
      const rowId = setting.data?.rowId ?? null;
      return rowId
        ? directus.request(updateItem('app_settings' as never, rowId, { value } as never))
        : directus.request(
            createItem(
              'app_settings' as never,
              { key: COMPENSATION_ESCALATION_SETTING_KEY, value } as never,
            ),
          );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t('escalation.saved', { defaultValue: 'Escalation recipients saved.' }));
    },
    onError: () =>
      toast.error(t('escalation.saveError', { defaultValue: 'Could not save that setting' })),
  });

  if (!isOwner || !draft) return null;
  const names = roleNames.data ?? [];
  const toggle = (target: string, role: string) =>
    setDraft((d) => {
      const cur = new Set(d?.[target] ?? []);
      if (cur.has(role)) cur.delete(role);
      else cur.add(role);
      return { ...(d ?? {}), [target]: [...cur] };
    });

  return (
    <section
      data-testid="compensation-escalation"
      aria-labelledby="compensation-escalation-title"
      className={cn(SECTION_CARD, 'mt-5 space-y-4 p-4')}
    >
      <div>
        <h2
          id="compensation-escalation-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          {t('escalation.title', { defaultValue: 'Yiji V2 compensation escalations' })}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('escalation.hint', {
            defaultValue:
              'When Yiji V2 escalates a case, every active user of the roles ticked here is notified. The Administrator always receives every escalation.',
          })}
        </p>
      </div>
      {COMPENSATION_ESCALATION_TARGETS.map((target) => (
        <fieldset key={target} className="space-y-1.5">
          <legend className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {target === 'Operations Manager'
              ? t('escalation.operationsManager', { defaultValue: 'V2 “Operations Manager”' })
              : t('escalation.relevantManagement', { defaultValue: 'V2 “Relevant management”' })}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {[...new Set([...names, ...(draft[target] ?? [])])].map((role) => {
              /* The Administrator is told of every escalation (owner rule): locked on. */
              const always = role === COMPENSATION_ESCALATION_ALWAYS_ROLE;
              return (
                <label key={role} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={always || (draft[target] ?? []).includes(role)}
                    disabled={always}
                    title={
                      always
                        ? t('escalation.always', {
                            defaultValue: 'The Administrator always receives every escalation.',
                          })
                        : undefined
                    }
                    onChange={() => toggle(target, role)}
                  />
                  {role}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
        {t('escalation.save', { defaultValue: 'Save recipients' })}
      </Button>
    </section>
  );
}
