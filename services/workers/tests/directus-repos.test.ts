import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { createTicketRepo, createNotificationsRepo } from '../src/processors/directus-repos.js';

const request = vi.fn();
const client = { request } as unknown as YijiDirectusClient;

beforeEach(() => request.mockReset());

describe('createTicketRepo', () => {
  const repo = createTicketRepo(client);

  it('listOpenTickets returns the rows from Directus', async () => {
    request.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
    expect(await repo.listOpenTickets()).toHaveLength(2);
  });

  it('listActiveSlaPolicies returns rows', async () => {
    request.mockResolvedValueOnce([{ id: 'p1' }]);
    expect(await repo.listActiveSlaPolicies()).toHaveLength(1);
  });

  it('getTicket returns the first row, or null when empty', async () => {
    request.mockResolvedValueOnce([{ id: 't9' }]);
    expect(await repo.getTicket('t9')).toEqual({ id: 't9' });
    request.mockResolvedValueOnce([]);
    expect(await repo.getTicket('absent')).toBeNull();
  });

  it('patchTicket issues an update request', async () => {
    request.mockResolvedValueOnce(undefined);
    await repo.patchTicket('t1', { status: 'closed' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('createTicketEvent persists an event with payload', async () => {
    request.mockResolvedValueOnce(undefined);
    await repo.createTicketEvent('t1', 'sla_breached', { reason: 'late' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('createTicketEvent tolerates an omitted payload', async () => {
    request.mockResolvedValueOnce(undefined);
    await repo.createTicketEvent('t1', 'assigned');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('createNotificationsRepo', () => {
  const repo = createNotificationsRepo(client);

  it('getUserPreferences returns the stored preferences', async () => {
    request.mockResolvedValueOnce({ notification_preferences: { email: 'on' } });
    expect(await repo.getUserPreferences('u1')).toEqual({ email: 'on' });
  });

  it('getUserPreferences defaults to {} when none stored', async () => {
    request.mockResolvedValueOnce({ notification_preferences: null });
    expect(await repo.getUserPreferences('u1')).toEqual({});
  });

  it('getUserPreferences returns {} when the read throws', async () => {
    request.mockRejectedValueOnce(new Error('no such user'));
    expect(await repo.getUserPreferences('u-missing')).toEqual({});
  });

  it('createNotification returns the new id', async () => {
    request.mockResolvedValueOnce({ id: 'n-1' });
    const out = await repo.createNotification({
      recipient: 'u1',
      type: 'mention',
      title: 'You were mentioned',
      body: 'see thread',
    });
    expect(out).toEqual({ id: 'n-1' });
  });
});
