import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * A COUPON DECISION CHANGES A TICKET, SO THE TICKET READERS MUST REFETCH.
 *
 * Approving writes `compensation`, `coupon_code` and the amounts onto the
 * ticket; the reports read exactly those columns. Only the approvals queue was
 * invalidated, so a supervisor who approved a coupon and went to Ticket
 * breakdown saw the row without its compensation and concluded the approval
 * had failed (owner, 2026-09-17).
 *
 * `refetchOnWindowFocus` does NOT cover it: the report sets
 * `staleTime: 60_000`, and focus never refetches data still considered fresh.
 *
 * Asserted against the source because the mutation's onSuccess needs a live
 * QueryClient, a Directus transport and a job producer to reach — mocking all
 * three to observe three invalidate calls would test the mocks. This fails the
 * moment a key is dropped, which is the regression worth catching.
 */
/** Vitest runs with the package as cwd, so paths are relative to it. */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const SOURCE = read('src/features/coupon-approvals/api.ts');

describe('deciding a coupon', () => {
  it.each(['coupon-approvals', 'agent-reports', 'complaint-metrics', 'dashboard-metrics'])(
    'invalidates the %s query',
    (key) => {
      expect(SOURCE).toContain(`queryKey: ['${key}']`);
    },
  );

  /* Keys are only useful if something actually reads them. A typo here is a
     silent no-op — the invalidation runs and refreshes nothing. */
  it.each([
    ['agent-reports', 'src/features/report-exports/api.ts'],
    ['complaint-metrics', 'src/features/dashboard/complaints-api.ts'],
  ])('uses %s, a key a real query owns', (key, file) => {
    expect(read(file)).toContain(`queryKey: ['${key}'`);
  });
});
