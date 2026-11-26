import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems } from '@directus/sdk';
import { Button, Input, Modal, Pill, StoreIcon, Textarea, cn, formatDate, toast } from '@yiji/ui';
import {
  BRANCH_MESSAGE_KIND,
  BRANCH_MESSAGE_MAX,
  BRANCH_MESSAGE_PER_HOUR,
  branchMessageHeading,
  branchMessageProblem,
  looksLikePhoneNumber,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { QuickReplies } from '../conversation/QuickReplies.js';
import { StorePicker } from '../tickets/ComplaintFields.js';
import type { StoreRow } from '../tickets/useStoreMatch.js';

/**
 * MESSAGE A BRANCH (owner, 26 Nov 2026): "send a custom only notification
 * without creating a ticket". A button in the top bar, beside Busy and the
 * bell, so it is one click from any page.
 *
 * The message rides the branch-notification outbox (`kind: 'custom'`) and is
 * printed on the branch's SaraPOS printer by the same sender as a ticket's
 * notification - retries, the kept SaraPOS reply, and on staging the lab
 * outlet only. The server decides who may send, the length and the hourly
 * limit; this form only says so before the agent presses Send.
 */

const FIELD_LABEL = 'block text-[0.8125rem] font-semibold leading-tight text-foreground/[0.78]';

/** The branches that have a SaraPOS outlet - the only ones that can print. */
function useBranchesOnSarapos() {
  return useQuery({
    queryKey: ['branch-message', 'sarapos-branches'],
    staleTime: 10 * 60_000,
    queryFn: async () =>
      new Set(
        (
          (await directus.request(
            readItems(
              'stores' as never,
              {
                limit: -1,
                fields: ['id'],
                filter: { sarapos_outlet_id: { _nnull: true } },
              } as never,
            ),
          )) as unknown as Array<{ id: string }>
        ).map((s) => s.id),
      ),
  });
}

export interface MyBranchMessage {
  id: string;
  status: 'queued' | 'sent' | 'failed';
  description: string | null;
  order_id: string | null;
  error: string | null;
  date_created: string | null;
  sent_at: string | null;
  store: { code: string | null; name: string | null } | null;
}

/** The signed-in person's last few messages, so they see whether each went. */
function useMyBranchMessages(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['branch-message', 'mine', user?.id],
    enabled: enabled && !!user?.id,
    refetchInterval: enabled ? 15_000 : false,
    queryFn: async () =>
      (await directus.request(
        readItems(
          'store_notifications' as never,
          {
            fields: [
              'id',
              'status',
              'description',
              'order_id',
              'error',
              'date_created',
              'sent_at',
              { store: ['code', 'name'] },
            ],
            filter: {
              kind: { _eq: BRANCH_MESSAGE_KIND },
              user_created: { _eq: '$CURRENT_USER' },
            },
            sort: ['-date_created'],
            limit: 5,
          } as never,
        ),
      )) as unknown as MyBranchMessage[],
  });
}

/** Directus' own sentence for a refusal, or null. */
function serverMessage(err: unknown): string | null {
  const e = err as { errors?: Array<{ message?: string }> } | null;
  const m = e?.errors?.[0]?.message;
  return typeof m === 'string' && m.trim() ? m : null;
}

export function BranchMessageButton(): JSX.Element | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('send_branch_messages')) return null;
  const label = t('branchMessage.open', { defaultValue: 'Message a branch' });
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-fast ease-out hover:bg-secondary hover:text-foreground motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <StoreIcon size={16} />
      </button>
      {open && <BranchMessageDialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

export function BranchMessageDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onSarapos = useBranchesOnSarapos();
  const mine = useMyBranchMessages(open);
  const [store, setStore] = useState('');
  const [orderId, setOrderId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const allow = useCallback((s: StoreRow) => onSarapos.data?.has(s.id) ?? false, [onSarapos.data]);

  const problem = branchMessageProblem(text);
  const phoneWarning = useMemo(() => looksLikePhoneNumber(text), [text]);
  const length = text.trim().length;
  const slashMatch = /^\/(.*)$/s.exec(text);

  const send = useMutation({
    mutationFn: () =>
      directus.request(
        createItem(
          'store_notifications' as never,
          {
            kind: BRANCH_MESSAGE_KIND,
            store,
            description: text.trim(),
            order_id: orderId.trim() || null,
          } as never,
        ),
      ),
    onSuccess: () => {
      toast.success(
        t('branchMessage.queued', {
          defaultValue: 'Sent to the branch printer queue. It prints within a minute.',
        }),
      );
      setText('');
      setOrderId('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['branch-message', 'mine'] });
    },
    onError: (err) =>
      setError(
        serverMessage(err) ??
          t('branchMessage.failed', {
            defaultValue: 'The message was not sent. Check your connection and try again.',
          }),
      ),
  });

  const canSend = !!store && problem === null && !send.isPending;

  const footer = (
    <>
      <Button type="button" variant="ghost" size="md" onClick={onClose}>
        {t('branchMessage.close', { defaultValue: 'Close' })}
      </Button>
      <Button
        type="button"
        size="md"
        disabled={!canSend}
        loading={send.isPending}
        onClick={() => send.mutate()}
      >
        {t('branchMessage.send', { defaultValue: 'Send to branch' })}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('branchMessage.title', { defaultValue: 'Message a branch' })}
      description={t('branchMessage.subtitle', {
        defaultValue:
          'Prints on the branch’s SaraPOS printer. No ticket is created. Never include customer details.',
      })}
      footer={footer}
    >
      <div className="space-y-5">
        <StorePicker
          value={store}
          onChange={(id) => {
            setStore(id);
            setError(null);
          }}
          allow={allow}
        />

        <label className="block space-y-2">
          <span className={FIELD_LABEL}>
            {t('branchMessage.order', { defaultValue: 'Order number (optional)' })}
          </span>
          <Input
            dir="ltr"
            inputMode="numeric"
            value={orderId}
            maxLength={40}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="1350658"
          />
        </label>

        <label className="block space-y-2">
          <span className={FIELD_LABEL}>
            {t('branchMessage.message', { defaultValue: 'Message' })}
          </span>
          {/* Ready messages, from their own library (Lists > Branch messages).
              Typing `/` searches it; a pick replaces the box, then edit it. */}
          <QuickReplies
            className="pb-1"
            kind="branch_message"
            floatAbove
            dismissSearchOnOutside
            customerText=""
            query={slashMatch?.[1] ?? ''}
            searching={slashMatch !== null}
            vars={{ order: orderId.trim() || null }}
            onPick={(picked) => {
              setText(picked);
              setError(null);
            }}
          />
          <Textarea
            rows={4}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder={t('branchMessage.placeholder', {
              defaultValue: 'What the branch needs to know or do.',
            })}
          />
          <div className="flex items-start justify-between gap-3 text-2xs">
            <span
              className={cn(
                phoneWarning ? 'font-semibold text-destructive' : 'text-muted-foreground',
              )}
            >
              {phoneWarning
                ? t('branchMessage.phoneWarning', {
                    defaultValue:
                      'This looks like a phone number. Do not send a customer’s number to a branch.',
                  })
                : t('branchMessage.limit', {
                    defaultValue: 'Up to {{n}} messages per branch per hour.',
                    n: BRANCH_MESSAGE_PER_HOUR,
                  })}
            </span>
            <span
              className={cn(
                'shrink-0 tabular-nums',
                problem === 'too_long' ? 'font-semibold text-destructive' : 'text-muted-foreground',
              )}
            >
              {length}/{BRANCH_MESSAGE_MAX}
            </span>
          </div>
        </label>

        {/* WHAT WILL PRINT - the heading SaraPOS shows, then the text. */}
        {text.trim() && (
          <div className="space-y-1.5">
            <span className={FIELD_LABEL}>
              {t('branchMessage.preview', { defaultValue: 'What the branch will see' })}
            </span>
            <div className="rounded-2xl bg-secondary/60 px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground">
              <p className="font-semibold">{branchMessageHeading(orderId)}</p>
              <p className="mt-1 whitespace-pre-wrap break-words">{text.trim()}</p>
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-2xl bg-destructive/10 px-3.5 py-2.5 text-xs leading-relaxed text-destructive"
          >
            {error}
          </p>
        )}

        <RecentMessages rows={mine.data ?? []} />
      </div>
    </Modal>
  );
}

/** "Your recent messages", with whether each one printed. */
function RecentMessages({ rows }: { rows: MyBranchMessage[] }): JSX.Element | null {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const tone = (s: MyBranchMessage['status']) =>
    s === 'sent' ? 'success' : s === 'failed' ? 'destructive' : 'neutral';
  const word = (s: MyBranchMessage['status']) =>
    s === 'sent'
      ? t('branchMessage.status.sent', { defaultValue: 'Sent' })
      : s === 'failed'
        ? t('branchMessage.status.failed', { defaultValue: 'Failed' })
        : t('branchMessage.status.queued', { defaultValue: 'Queued' });
  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <span className={FIELD_LABEL}>
        {t('branchMessage.recent', { defaultValue: 'Your recent messages' })}
      </span>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                {[r.store?.code, r.store?.name].filter(Boolean).join(' ')}
                {r.order_id ? ` · ${r.order_id}` : ''}
              </p>
              <p className="truncate text-muted-foreground">{r.description}</p>
              {r.status === 'failed' && r.error && (
                <p className="truncate text-destructive">{r.error}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Pill tone={tone(r.status)}>{word(r.status)}</Pill>
              <span className="text-2xs text-muted-foreground">
                {r.date_created ? formatDate(r.date_created) : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
