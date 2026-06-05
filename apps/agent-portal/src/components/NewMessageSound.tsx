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
      cleanup = () => socket.off(SOCKET_EVENTS.inboxActivity, onActivity);
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}
