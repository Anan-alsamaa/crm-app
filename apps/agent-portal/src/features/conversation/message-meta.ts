import { isAutomatedAgentMessage, type SenderFields } from '@yiji/shared-types';

/**
 * WHO SENT IT, AND WHEN (EMA-77 + EMA-78, ops 2026-10-15 / 2026-10-18).
 *
 * EMA-77: every agent bubble read "You", so with several agents in one chat
 * nobody could tell who had said what. Each agent run is now labelled with
 * the SENDER'S name, resolved from `sender_user` (the id the gateway stamps
 * from the authenticated socket, already selected for EMA-33) against the
 * agents list the inbox already loads — no gateway change. The automatic
 * welcome (an agent message with an explicit NULL user) stays labelled as
 * automated, never as a person.
 *
 * EMA-78: the clock time on every bubble, in the viewer's local time, with the
 * existing day separators above.
 */

export interface PersonName {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name?: string | null;
}

/** The sender's user id, or undefined when unknown (never selected / not sent). */
export function senderIdOf(m: SenderFields): string | undefined {
  const u = m.sender_user;
  if (typeof u === 'string') return u;
  if (u && typeof u === 'object' && typeof u.id === 'string') return u.id;
  return undefined;
}

/** First name, else the email; null when there is nothing to show. */
export function personName(p: Pick<PersonName, 'email' | 'first_name'> | null | undefined) {
  const first = p?.first_name?.trim();
  if (first) return first;
  const email = p?.email?.trim();
  return email || null;
}

export type AgentSenderLabel =
  /** The automatic welcome — nobody wrote it. */
  | { kind: 'automated' }
  /** The viewer's own reply; `name` null when their profile has none. */
  | { kind: 'self'; name: string | null }
  /** A colleague's reply; `name` null when they cannot be resolved. */
  | { kind: 'agent'; name: string | null };

/**
 * How to label an agent message for the agent reading the thread.
 *
 * Unknown sender (no id on a live echo) is treated as a person, not as the
 * automatic welcome — the same rule `isAutomatedAgentMessage` keeps.
 */
export function agentSenderLabel(
  m: SenderFields,
  viewer: PersonName | null | undefined,
  agents: readonly PersonName[] | undefined,
): AgentSenderLabel {
  if (isAutomatedAgentMessage(m)) return { kind: 'automated' };
  const id = senderIdOf(m);
  if (id && viewer && id === viewer.id) {
    const fromList = agents?.find((a) => a.id === id);
    return { kind: 'self', name: personName(viewer) ?? personName(fromList) };
  }
  if (!id) return { kind: 'agent', name: null };
  return { kind: 'agent', name: personName(agents?.find((a) => a.id === id)) };
}

/**
 * Do two consecutive agent messages belong to the same run? Only when the
 * same person sent them — two colleagues answering back to back are two runs,
 * each under its own name.
 */
export function sameAgentSender(a: SenderFields, b: SenderFields): boolean {
  return senderIdOf(a) === senderIdOf(b);
}

/** "14:05" — 24-hour, Latin digits, local time; as `formatDateTime` in @yiji/ui. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
