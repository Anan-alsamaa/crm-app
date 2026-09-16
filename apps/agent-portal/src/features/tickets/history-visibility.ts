/**
 * Who may read a ticket's edit history.
 *
 * "What changed" is the audit trail: every field edit with the person who made
 * it, built from Directus's own revisions. That is a SUPERVISORY view — it
 * exists so somebody can check work — and showing it to the agent whose work it
 * records changes what the panel is for (owner, 2026-09-16).
 *
 * Matched on the role NAME rather than a privilege or `admin_access`, because
 * the role list is the vocabulary the owner works in and `admin_access` would
 * exclude WeCare Supervisor, who is exactly the person this is for.
 *
 * FAILS CLOSED. Anything unrecognised — a renamed role, a new one, a missing
 * role — hides the panel. Hidden when it should show is a complaint somebody
 * makes; shown when it should not is an agent reading an audit trail of
 * themselves, which nobody reports because it looks like a feature.
 */
const HISTORY_ROLES = new Set(['administrator', 'admin', 'wecare admin', 'wecare supervisor']);

export function canSeeFieldHistory(roleName: string | null | undefined): boolean {
  return HISTORY_ROLES.has((roleName ?? '').trim().toLowerCase());
}
