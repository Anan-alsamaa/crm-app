import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/** Admin automation API. */

export type TriggerEvent =
  | 'conversation_created'
  | 'message_received'
  | 'ticket_created'
  | 'ticket_status_changed'
  | 'sla_warning'
  | 'sla_breach'
  | 'inactivity'
  | 'keyword_matched';

export interface RuleCondition {
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'starts_with' | 'gt' | 'lt' | 'in';
  value: string | number | string[];
}

export interface RuleAction {
  kind:
    | 'assign_team'
    | 'assign_agent'
    | 'set_priority'
    | 'set_status'
    | 'add_tag'
    | 'send_notification'
    | 'escalate';
  params: Record<string, unknown>;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger_event: TriggerEvent;
  conditions: RuleCondition[] | null;
  actions: RuleAction[] | null;
  active: boolean;
  priority: number;
  last_triggered_at: string | null;
  trigger_count: number;
}

export type AutomationRuleInput = Omit<
  AutomationRule,
  'id' | 'last_triggered_at' | 'trigger_count'
>;

export function useAutomationRules() {
  return useQuery({
    queryKey: ['automation-rules'],
    queryFn: () =>
      directus.request(
        readItems('automation_rules', {
          fields: [
            'id',
            'name',
            'description',
            'trigger_event',
            'conditions',
            'actions',
            'active',
            'priority',
            'last_triggered_at',
            'trigger_count',
          ],
          sort: ['-priority', 'name'],
          limit: -1,
        }),
      ) as Promise<AutomationRule[]>,
  });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationRuleInput) =>
      directus.request(createItem('automation_rules', input as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AutomationRuleInput> }) =>
      directus.request(updateItem('automation_rules', id, patch as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('automation_rules', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation-rules'] }),
  });
}
