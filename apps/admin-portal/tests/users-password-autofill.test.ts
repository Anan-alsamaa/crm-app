import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The agent-login drift, pinned so it cannot come back.
 *
 * For weeks the demo agent's password kept "rotting" with no explanation, and
 * every seeder in the repo was ruled out. The audit trail had recorded it
 * correctly the entire time — update rows on that user carrying a `password`
 * key with `origin=http://localhost:8092`, the admin portal — but nobody read
 * them, so it looked spontaneous.
 *
 * What actually happened: an admin opens a user to change a team or a name. The
 * browser sees a password box in a form beside an email box, on a host it has a
 * saved credential for, and fills both. The admin never sees it, saves the team
 * change, and the edited account silently takes on somebody else's password.
 *
 * Asserted against the source because the failure is an ATTRIBUTE not being
 * there. Rendering the form and checking behaviour would not catch it: jsdom
 * has no password manager, so the form behaves perfectly in a test and breaks
 * only in a real browser belonging to someone who has signed in before.
 */
// Resolved from the working directory, not import.meta.url: Vitest rewrites
// that to the dev server's scheme, which readFileSync will not take.
const SOURCE = readFileSync(resolve('src/features/users/UsersPage.tsx'), 'utf8');

describe('the user editor cannot be autofilled into changing a password', () => {
  it('marks the password field new-password, as every other one in the app does', () => {
    // Generous window: the attribute sits below a long comment explaining why.
    const field = SOURCE.slice(SOURCE.indexOf('type="password"'));
    expect(field.slice(0, 1500)).toContain('autoComplete="new-password"');
  });

  it('keeps the email field out of the pair the browser looks for', () => {
    const field = SOURCE.slice(SOURCE.indexOf('type="email"'));
    expect(field.slice(0, 400)).toContain('autoComplete="off"');
  });

  it('sends a password only when a human typed one', () => {
    // Non-empty is not enough: an autofilled box is non-empty and untouched.
    expect(SOURCE).toContain('dirtyFields.password');
  });
});
