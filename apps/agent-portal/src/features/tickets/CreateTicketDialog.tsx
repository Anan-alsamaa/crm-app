import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Button, FormField, Input, Select, Textarea, toast } from '@yiji/ui';
import type { Priority } from '@yiji/shared-types';
import { useCreateTicket } from './api.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

const schema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});
type FormValues = z.infer<typeof schema>;

interface Props {
  contactId: string;
  vendorId: string;
  conversationId?: string | null;
  onClose: () => void;
}

export function CreateTicketDialog({ contactId, vendorId, conversationId, onClose }: Props) {
  const { t } = useTranslation();
  const createTicket = useCreateTicket();
  const { user } = useAuth();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { priority: 'medium' },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createTicket.mutateAsync({
        subject: values.subject,
        description: values.description,
        priority: values.priority,
        contact: contactId,
        vendor: vendorId,
        conversation: conversationId ?? null,
        assigned_agent: user?.id ?? null,
      } as Parameters<typeof createTicket.mutateAsync>[0]);
      toast.success(
        t('tickets.created', { defaultValue: 'Ticket created' }),
        { description: values.subject },
      );
      onClose();
    } catch {
      toast.error(t('tickets.createError'));
    }
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-3xl bg-card p-7 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in">
        <div className="mb-6 space-y-1.5">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
            {t('tickets.createTitle')}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('tickets.createHint', {
              defaultValue: 'Capture the work as a ticket so it can be tracked against an SLA.',
            })}
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormField label={t('tickets.subject')} error={errors.subject?.message}>
            <Input invalid={!!errors.subject} {...register('subject')} />
          </FormField>
          <FormField label={t('tickets.description')}>
            <Textarea rows={3} {...register('description')} />
          </FormField>
          <FormField label={t('conversation.priority')}>
            <Select {...register('priority')}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`, { ns: 'common' })}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button type="submit" size="md" loading={isSubmitting}>
              {t('tickets.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
