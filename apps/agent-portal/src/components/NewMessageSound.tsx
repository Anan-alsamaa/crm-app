import { useEffect } from 'react';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { getSocket } from '../lib/socket.js';
import { playMessageBeep } from '../lib/sound.js';

/**
 * App-wide new-message beep. Mounted once in the shell; listens for inbox
 * activity (any new message across conversations) and plays the notification
 * sound. Muting + self-send suppression live in lib/sound.
 */
export function NewMessageSound() {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const onActivity = () => playMessageBeep();
      socket.on(SOCKET_EVENTS.inboxActivity, onActivity);
      /*
       * A CHAT HANDED TO YOU MAKES A SOUND TOO.
       *
       * This listened only for `inbox:activity`, which the gateway emits when a
       * MESSAGE arrives. An assignment is a database write and no message, so
       * being given a waiting customer was completely silent — the agent found
       * out by looking (owner, 2026-09-16).
       *
       * `notification:pushed` is per recipient, so this beeps for the agent the
       * chat went to and nobody else.
       */
      socket.on(SOCKET_EVENTS.notificationPushed, onActivity);
      cleanup = () => {
        socket.off(SOCKET_EVENTS.inboxActivity, onActivity);
        socket.off(SOCKET_EVENTS.notificationPushed, onActivity);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}
