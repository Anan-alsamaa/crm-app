import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_MENTIONS,
  mentionCandidates,
  mentionJobId,
  notifyNoteMentions,
} from '../src/mention-notify.js';

/**
 * A chat note that @mentions a colleague must reach them as an in-app
 * `mention` notification (owner 2026-10-09). The gateway used to drop the
 * `mentions` array on the floor.
 */
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const note = {
  noteId: 'm1',
  conversationId: 'c1',
  authorId: 'author',
  content: 'please check   this @sara',
  mentions: ['sara', 'author', 'ghost', 'sara'],
};

function deps(active: Array<{ id: string; name: string | null }>) {
  return {
    activeUsers: vi.fn(async (ids: string[]) => active.filter((u) => ids.includes(u.id))),
    enqueueNotification: vi.fn(async (_job: unknown, jobId: string) => jobId),
    logger,
  };
}

describe('note mention notifications', () => {
  it('notifies each active mentioned colleague once, never the author or unknown ids', async () => {
    const d = deps([
      { id: 'author', name: 'Omar Ali' },
      { id: 'sara', name: 'Sara' },
    ]);
    expect(await notifyNoteMentions(d, note)).toBe(1);
    expect(d.enqueueNotification).toHaveBeenCalledTimes(1);
    const [job, jobId] = d.enqueueNotification.mock.calls[0]!;
    expect(jobId).toBe(mentionJobId('m1', 'sara'));
    expect(job).toEqual({
      recipientId: 'sara',
      type: 'mention',
      title: 'Omar Ali mentioned you in a chat note',
      body: 'please check this @sara',
      link: '/?conv=c1',
      payload: { entityType: 'conversation', conversationId: 'c1', messageId: 'm1' },
    });
  });

  it('does nothing without mentions, and never throws', async () => {
    const d = deps([]);
    expect(await notifyNoteMentions(d, { ...note, mentions: undefined })).toBe(0);
    expect(d.activeUsers).not.toHaveBeenCalled();
    d.activeUsers.mockRejectedValueOnce(new Error('directus down'));
    expect(await notifyNoteMentions(d, note)).toBe(0);
  });

  it('rejects malformed ids and caps the list', () => {
    expect(mentionCandidates(['a:b', ' ', 'ok'], 'x')).toEqual(['ok']);
    const many = Array.from({ length: 50 }, (_, i) => `u${i}`);
    expect(mentionCandidates(many, 'x')).toHaveLength(MAX_MENTIONS);
  });

  it('note:add hands its mentions to the notifier', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'connection.ts'), 'utf8');
    const handler = src.slice(src.indexOf('socket.on(SOCKET_EVENTS.noteAdd'));
    expect(handler.slice(0, 4000)).toMatch(/notifyNoteMentions\(/);
  });
});
