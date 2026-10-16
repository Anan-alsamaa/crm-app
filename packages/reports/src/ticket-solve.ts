/**
 * TICKET TIME-TO-SOLVE AND THE CHAT A TICKET CAME FROM — ONE RULE, two reports.
 *
 * The Agent summary (median ticket solve per agent) and Ticket deadlines (one
 * row per ticket) both read a ticket's solve time from here, so they cannot
 * disagree about the same ticket.
 *
 * WHY A BARE `resolved_at - date_created` IS WRONG (prod, 14-15 Oct 2026):
 *
 *  - Most tickets are LOGGED from a chat after the work is done: the customer
 *    wrote at 11:08, the agent settled it in the chat, and the ticket was
 *    raised at 11:28 and closed 5 seconds later. The work started when the
 *    CUSTOMER wrote, not when the paperwork was filed.
 *  - `resolved_at` is stamped by the agent's BROWSER (`new Date()`), and the
 *    agents' PC clocks run ~2.5 minutes behind the server that stamps
 *    `date_created`. So a ticket closed seconds after it was raised carries a
 *    solve time BEFORE its creation. Read as a backwards clock it was dropped
 *    ("—"); read as 0 it reported Sultan's median as 0s. Neither is true.
 *
 * The rule:
 *   start = the first customer message of the chat SESSION the ticket was
 *           raised from, when that is earlier than the ticket's creation;
 *           else the ticket's `date_created`.
 *   end   = `resolved_at`, unless it is missing or earlier than `start` — then
 *           the server's own record of the solve (the revision that set the
 *           status to solved), which cannot run behind.
 *   Null only when no end can be found at all.
 */
import { businessSecondsBetween, type SlaBusinessHours } from '@yiji/shared-types';
import { conversationTimestamps, type TimingMessage } from './chat-timings.js';

export interface TicketSolveInput {
  /** Server-stamped creation. */
  createdAt: string | null | undefined;
  /** Browser-stamped solve time (may run behind the server). */
  resolvedAt: string | null | undefined;
  /** First customer message of the chat session the ticket was raised from. */
  chatStartAt?: string | null;
  /** When the SERVER recorded the ticket becoming solved (revision activity). */
  solvedServerAt?: string | null;
}

export interface TicketSolveSpan {
  start: string;
  end: string;
  /** `chat` when the clock starts at the customer's first message. */
  startBasis: 'chat' | 'ticket';
  /** `server` when the browser's `resolved_at` was missing or impossible. */
  endBasis: 'resolved' | 'server' | 'instant';
}

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
};

/** The start and end a ticket's solve time is measured between, or null. */
export function ticketSolveSpan(i: TicketSolveInput): TicketSolveSpan | null {
  const created = ms(i.createdAt);
  const chat = ms(i.chatStartAt);
  let start: string;
  let startBasis: TicketSolveSpan['startBasis'];
  if (chat != null && (created == null || chat < created)) {
    start = i.chatStartAt!;
    startBasis = 'chat';
  } else if (created != null) {
    start = i.createdAt!;
    startBasis = 'ticket';
  } else {
    return null;
  }
  const s = ms(start)!;
  const resolved = ms(i.resolvedAt);
  if (resolved != null && resolved >= s) {
    return { start, end: i.resolvedAt!, startBasis, endBasis: 'resolved' };
  }
  const server = ms(i.solvedServerAt);
  if (server != null && server >= s) {
    return { start, end: i.solvedServerAt!, startBasis, endBasis: 'server' };
  }
  /* A solve stamp exists but every one is before the start, and there is no
     server record to correct it: solved the moment it was raised. */
  if (resolved != null || server != null) {
    return { start, end: start, startBasis, endBasis: 'instant' };
  }
  return null;
}

/** Working seconds from start to end of `ticketSolveSpan`, or null. */
export function ticketSolveSec(
  i: TicketSolveInput,
  hours: SlaBusinessHours | null | undefined = null,
): number | null {
  const span = ticketSolveSpan(i);
  if (!span) return null;
  if (span.endBasis === 'instant') return 0;
  return businessSecondsBetween(span.start, span.end, hours);
}

/**
 * A silence this long between two messages of one thread is a new session even
 * without a system "closing" notice between them.
 */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * The chat SESSION a ticket was raised from: its first customer message and
 * the first human reply to it.
 *
 * A contact keeps ONE conversation for life and it reopens when they write
 * again, so neither the thread's first message nor
 * `conversations.first_responded_at` (which belongs to the LATEST session,
 * often one after the ticket) is the ticket's. The session is the run of
 * messages after the last system "closing this chat" notice that precedes the
 * customer's last message at or before the ticket was raised, up to the next
 * such notice — or up to a silence longer than `SESSION_GAP_MS`: a chat that
 * reopened without a closing notice (prod ticket 6fa6dfba: 2 Oct and 14 Oct in
 * one run) must not start the 14 Oct ticket's clock on 2 Oct.
 *
 * The reply is the shared rule (`conversationTimestamps`): the first HUMAN
 * agent message at or after the customer's first — the automatic welcome is
 * not a reply. `messages` must exclude internal notes and carry `sender_user`.
 *
 * Null when the chat has no customer message at or before the ticket.
 */
export function ticketChatSession(
  messages: readonly TimingMessage[],
  ticketCreatedAt: string | null | undefined,
): { customerAt: string; agentAt: string | null } | null {
  const msgs = messages
    .filter((m) => !!m.date_created)
    .slice()
    .sort((a, b) =>
      a.date_created! < b.date_created! ? -1 : a.date_created! > b.date_created! ? 1 : 0,
    );
  if (msgs.length === 0) return null;
  const cutoff = ticketCreatedAt ?? msgs[msgs.length - 1]!.date_created!;
  let lastCustomer = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.date_created! > cutoff) break;
    if (msgs[i]!.sender_type === 'customer') lastCustomer = i;
  }
  if (lastCustomer < 0) return null;
  const gap = (i: number) =>
    Date.parse(msgs[i]!.date_created!) - Date.parse(msgs[i - 1]!.date_created!) > SESSION_GAP_MS;
  let start = 0;
  for (let i = lastCustomer; i >= 0; i--) {
    if (i < lastCustomer && msgs[i]!.sender_type === 'system') {
      start = i + 1;
      break;
    }
    if (i > 0 && gap(i)) {
      start = i;
      break;
    }
  }
  let end = msgs.length;
  for (let i = lastCustomer + 1; i < msgs.length; i++) {
    if (msgs[i]!.sender_type === 'system' || gap(i)) {
      end = i;
      break;
    }
  }
  const session = msgs.slice(start, end);
  const times = conversationTimestamps(session).get(session[0]!.conversation);
  if (!times?.firstCustomerAt) return null;
  return { customerAt: times.firstCustomerAt, agentAt: times.firstAgentAt };
}
