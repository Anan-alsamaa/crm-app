import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Button, Input, Modal, Spinner, Textarea, cn } from '@yiji/ui';
import { cleanContactName, isDialablePhone, normalizePhone } from '@yiji/shared-types';
import { useQuery } from '@tanstack/react-query';
import { lookupContactByPhone, soleYijiVendorId, startChatWithCustomer } from './start-chat.js';
import { QuickReplies } from '../conversation/QuickReplies.js';

/**
 * AN AGENT OPENS A CHAT WITH A CUSTOMER WHO HAS NOT WRITTEN TO US (EMA-10).
 *
 * Until now the customer always spoke first. This is the other direction: a
 * complaint taken by phone, a promised callback, a check on a late order.
 *
 * The endpoint (EMA-9) resolves the customer and the thread but deliberately
 * does NOT send the message — the agent's own socket does that through the
 * ordinary path, which already persists, broadcasts and enqueues the customer
 * push. So this dialog is two steps, and the order matters: resolve first, then
 * send. If the send fails the conversation still exists and the agent is landed
 * in it with their text intact, rather than losing both.
 *
 * WHO THEY ARE ABOUT TO MESSAGE, BEFORE THEY SEND. The phone box resolves on
 * blur and says whether this is a known contact — with their name — or somebody
 * new. An outbound message is not recoverable, and "0501234567" alone is not
 * enough for an agent to be sure they have the right person.
 *
 * AND IF A THREAD ALREADY EXISTS, IT SAYS SO. The endpoint answers `created:
 * false` when the customer already had a live conversation; silently appending
 * to a thread the agent did not know about is how somebody walks into the
 * middle of a colleague's case.
 */

export interface StartChatDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called once the conversation exists and the first message is away.
   * The inbox opens it in the thread pane — same page, no navigation.
   */
  onStarted: (conversationId: string) => void;
}

/** What we know about the number currently typed. */
type Lookup =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'known'; name: string | null; phone: string }
  | { state: 'new'; phone: string }
  /* The lookup failed. DISTINCT from "new": telling an agent a known customer
     is new would be worse than saying nothing, so this says nothing. */
  | { state: 'unknown' };

export function StartChatDialog({ open, onClose, onStarted }: StartChatDialogProps) {
  const { t } = useTranslation();
  /*
   * THE YIJI VENDOR ID, resolved here rather than passed in — the inbox has no
   * reason to know about vendors, and the one caller that did would have had to
   * learn the CRM-uuid-vs-Yiji-id distinction that this feature turns on.
   */
  const vendor = useQuery({
    queryKey: ['sole-yiji-vendor'],
    staleTime: 5 * 60_000,
    queryFn: soleYijiVendorId,
  });
  const vendorId = vendor.data ?? undefined;
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  /* A fresh dialog every time. Reopening with the last customer's number still
     in the box is how a message reaches the wrong person. */
  useEffect(() => {
    if (!open) return;
    setPhone('');
    setMessage('');
    setLookup({ state: 'idle' });
    setError(null);
  }, [open]);

  const canonical = normalizePhone(phone);
  const phoneValid = isDialablePhone(canonical);

  /*
   * WHO IS THIS, resolved on blur rather than on every keystroke.
   *
   * A partial number matches nobody, so per-keystroke lookups are a request per
   * character for an answer that is wrong until the last one. Blur is the
   * moment the agent has finished typing and is about to move to the message.
   */
  const check = async () => {
    if (!phoneValid || !vendorId) {
      setLookup({ state: 'idle' });
      return;
    }
    setLookup({ state: 'checking' });
    try {
      const found = await lookupContactByPhone(canonical);
      setLookup(
        found
          ? // A stored name that is only the number is no name (owner, 2026-10-07).
            { state: 'known', name: cleanContactName(found.name), phone: canonical }
          : { state: 'new', phone: canonical },
      );
    } catch {
      setLookup({ state: 'unknown' });
    }
  };

  const start = useMutation({
    mutationFn: async () => {
      if (!vendorId) throw new Error('no vendor');
      return startChatWithCustomer({ phone: canonical, vendorId, message: message.trim() });
    },
    onSuccess: (res) => {
      /*
       * JOINED, NOT STARTED. Said plainly rather than left for the agent to
       * discover from a thread that already has history in it.
       */
      onStarted(res.conversationId);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const ready = phoneValid && !!message.trim() && !!vendorId && !start.isPending;

  /* The inbox's "/" gesture, so the first message can start from a ready
     reply exactly as every later one can (owner, 2026-10-05). */
  const slashMatch = /^\/(.*)$/s.exec(message);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('inbox.startChat.title', { defaultValue: 'Start a chat' })}
    >
      <div className="space-y-4 px-5 py-4">
        {/* THE NUMBER. `inputMode="tel"` so a phone keyboard appears, and the
            canonical form is shown back once it resolves — an agent who typed
            `+966 50 …` should see the `05…` the CRM actually stores. */}
        <label className="block space-y-1.5">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('inbox.startChat.phone', { defaultValue: 'Customer mobile' })}
          </span>
          <Input
            ref={phoneRef}
            autoFocus
            inputMode="tel"
            dir="ltr"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              /* Any edit invalidates what we knew — the name on screen must
                 never belong to a different number than the one in the box. */
              setLookup({ state: 'idle' });
              setError(null);
            }}
            onBlur={() => void check()}
            placeholder="05XXXXXXXX"
          />
          <WhoIsThis lookup={lookup} typed={phone} valid={phoneValid} />
        </label>

        {/* THE FIRST MESSAGE. Free text, per the spec — whether a cold outbound
            needs an approved template is a separate decision (EMA-15), and
            guessing at one now would ship a restriction nobody asked for. */}
        <label className="block space-y-1.5">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('inbox.startChat.message', { defaultValue: 'First message' })}
          </span>
          {/*
            QUICK REPLIES, from the same library as the inbox composer (owner,
            2026-10-05: the first message of an agent-started chat had none).
            Typing `/` searches it, or the button opens it. A pick REPLACES the
            box — the inbox's own rule since 2026-09-09. `{name}` fills from
            the customer found for this number, when there is one.

            ABOVE the box, and the list opens UPWARD past the dialog's top
            (owner, 2026-10-06): under the box it had too little room, and it
            may freely cover the number field — never the message being typed.
          */}
          <QuickReplies
            className="pb-1"
            floatAbove
            dismissSearchOnOutside
            customerText=""
            query={slashMatch?.[1] ?? ''}
            searching={slashMatch !== null}
            vars={{ name: lookup.state === 'known' ? lookup.name : null }}
            onPick={(text) => {
              setMessage(text);
              setError(null);
            }}
          />
          <Textarea
            rows={4}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setError(null);
            }}
            placeholder={t('inbox.startChat.messagePlaceholder', {
              defaultValue: 'What you want to say to them.',
            })}
          />
        </label>

        {/* THE FAILURE, where the agent is looking, in words rather than a
            status code. */}
        {error && (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {/* WHY the button is dead, since a disabled control cannot explain
            itself and "nothing happens" is the most-reported shape in this
            app. */}
        {!ready && !start.isPending && (
          <p className="me-auto text-2xs leading-snug text-muted-foreground">
            {!phoneValid
              ? t('inbox.startChat.needPhone', { defaultValue: 'Enter a valid mobile number.' })
              : !message.trim()
                ? t('inbox.startChat.needMessage', { defaultValue: 'Write the first message.' })
                : t('inbox.startChat.needVendor', { defaultValue: 'No vendor is configured.' })}
          </p>
        )}
        <Button type="button" variant="ghost" onClick={onClose} disabled={start.isPending}>
          {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
        </Button>
        <Button
          type="button"
          disabled={!ready}
          loading={start.isPending}
          onClick={() => start.mutate()}
        >
          {t('inbox.startChat.send', { defaultValue: 'Send' })}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * WHO THE AGENT IS ABOUT TO MESSAGE.
 *
 * Four states, and each says something different. "Unknown" deliberately says
 * NOTHING about whether the customer exists — a failed lookup rendered as "new
 * customer" would be a confident lie, and the agent can still send.
 */
function WhoIsThis({ lookup, typed, valid }: { lookup: Lookup; typed: string; valid: boolean }) {
  const { t } = useTranslation();
  /* Nothing typed yet is not an error — the field opens empty and focused. */
  if (!typed.trim()) return null;
  if (!valid) {
    return (
      <p className="text-2xs text-destructive">
        {t('inbox.startChat.invalidPhone', { defaultValue: 'That is not a mobile number.' })}
      </p>
    );
  }
  if (lookup.state === 'checking') {
    return (
      <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Spinner size={11} />
        {t('inbox.startChat.checking', { defaultValue: 'Looking them up…' })}
      </p>
    );
  }
  if (lookup.state === 'known') {
    return (
      <p className={cn('text-2xs font-medium text-foreground')}>
        {lookup.name
          ? t('inbox.startChat.known', {
              name: lookup.name,
              defaultValue: 'Known customer — {{name}}',
            })
          : t('inbox.startChat.knownNoName', {
              defaultValue: 'Known customer, no name on file',
            })}
      </p>
    );
  }
  if (lookup.state === 'new') {
    return (
      <p className="text-2xs text-muted-foreground">
        {t('inbox.startChat.newContact', { defaultValue: 'New customer — no record yet' })}
      </p>
    );
  }
  /* `idle` (not checked yet) and `unknown` (the check failed) both say nothing.
     Silence is honest; a guess is not. */
  return null;
}
