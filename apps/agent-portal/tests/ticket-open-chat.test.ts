import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toComplaintRow } from '../src/features/complaints/api.js';

/**
 * "OPEN CHAT" ON EVERY TICKET (owner, 2026-10-11): each ticket in the list
 * offers a button that opens the chat it came from.
 */
const base = {
  id: 'tk-1',
  status: 'pending',
  subject: null,
  complaint_date: null,
  first_responded_at: null,
  first_response_due_at: null,
  date_created: null,
  description: null,
  complaint_type: null,
  service_type: null,
  complaint_source: null,
  communication_method: null,
  response_desc: null,
  compensation: null,
  coupon_code: null,
  coupon_value: null,
  coupon_percent: null,
  order_snapshot: null,
  order_id: null,
  store_snapshot: null,
  contact: null,
} as Parameters<typeof toComplaintRow>[0];

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('Open chat on each ticket', () => {
  it('the list row carries the ticket’s chat', () => {
    expect(toComplaintRow({ ...base, conversation: 'conv-9' }, 'A').conversation).toBe('conv-9');
    expect(toComplaintRow(base, 'A').conversation).toBeNull();
  });

  it('the list query asks for the conversation column', () => {
    expect(read('src/features/complaints/api.ts')).toMatch(/'conversation',\s*\] as const/);
  });

  it('each row renders the button only when there is a chat, and checks access on click', () => {
    const page = read('src/features/tickets/TicketsPage.tsx');
    expect(page).toMatch(/\{r\.conversation && \(/);
    expect(page).toMatch(/onClick=\{\(\) => void openChat\(r\.conversation!\)\}/);
    expect(page).toMatch(/canReadConversation\(conversationId\)/);
    expect(page).toMatch(/navigate\(`\/\?conv=\$\{encodeURIComponent\(conversationId\)\}`\)/);
  });

  it('the label exists in English and Arabic', () => {
    expect(JSON.parse(read('src/i18n/en.json')).tickets.openChat).toBe('Open chat');
    expect(JSON.parse(read('src/i18n/ar.json')).tickets.openChat).toBeTruthy();
  });
});
