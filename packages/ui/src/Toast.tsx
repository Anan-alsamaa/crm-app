import type { JSX } from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import { cn } from './cn.js';

/*
 * Toast system — Sonner-inspired but tiny.
 *
 * Usage:
 *   1. Mount <Toaster /> once at the app root
 *   2. Call `toast.success('Saved')` / `toast.error('Failed')` / `toast('Info')`
 *      from anywhere
 *
 * The toaster subscribes to a module-level event bus, so toasts can fire from
 * code that doesn't have access to React context (mutations, sockets, etc).
 */

export type ToastTone = 'default' | 'success' | 'error' | 'warning';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss in ms. Default 4000. Pass 0 to make it sticky. */
  durationMs?: number;
}

interface ToastRecord extends ToastInput {
  id: string;
  durationMs: number;
}

type Listener = (t: ToastRecord) => void;
const listeners = new Set<Listener>();
let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${seq++}`;

function publish(input: ToastInput): string {
  const rec: ToastRecord = {
    id: nextId(),
    title: input.title,
    description: input.description,
    tone: input.tone ?? 'default',
    durationMs: input.durationMs ?? 4000,
  };
  listeners.forEach((l) => l(rec));
  return rec.id;
}

export const toast = Object.assign(
  (title: string, opts?: Omit<ToastInput, 'title'>) => publish({ ...opts, title }),
  {
    success: (title: string, opts?: Omit<ToastInput, 'title' | 'tone'>) =>
      publish({ ...opts, title, tone: 'success' }),
    error: (title: string, opts?: Omit<ToastInput, 'title' | 'tone'>) =>
      publish({ ...opts, title, tone: 'error' }),
    warning: (title: string, opts?: Omit<ToastInput, 'title' | 'tone'>) =>
      publish({ ...opts, title, tone: 'warning' }),
  },
);

const toneStyles: Record<ToastTone, string> = {
  default: 'bg-card text-card-foreground',
  success: 'bg-card text-card-foreground',
  error: 'bg-card text-card-foreground',
  warning: 'bg-card text-card-foreground',
};

const toneIconBg: Record<ToastTone, string> = {
  default: 'bg-primary-subtle text-primary',
  success: 'bg-success/15 text-success',
  error: 'bg-destructive/15 text-destructive',
  warning: 'bg-warning/20 text-warning-foreground',
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
        aria-hidden
      >
        <path d="m3 8 3.5 3.5L13 5" />
      </svg>
    );
  }
  if (tone === 'error') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="h-3.5 w-3.5"
        aria-hidden
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  if (tone === 'warning') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
        aria-hidden
      >
        <path d="M8 3v6" />
        <path d="M8 12.5v0" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11v0" />
    </svg>
  );
}

interface ToasterProps {
  /** Where to anchor. Defaults to end-bottom. */
  position?: 'top' | 'bottom';
  /** Max number of toasts on screen at once. */
  max?: number;
}

export function Toaster({ position = 'bottom', max = 4 }: ToasterProps = {}): JSX.Element {
  const [items, setItems] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const onToast: Listener = (t) => {
      setItems((prev) => {
        const next = [...prev, t];
        return next.length > max ? next.slice(next.length - max) : next;
      });
      if (t.durationMs > 0) {
        setTimeout(() => dismiss(t.id), t.durationMs);
      }
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, [dismiss, max]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className={cn(
        'pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4',
        position === 'top' ? 'top-4' : 'bottom-4 flex-col-reverse',
      )}
    >
      {items.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast: t, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  const tone = t.tone ?? 'default';
  const labelId = useId();
  return (
    <div
      role="status"
      aria-labelledby={labelId}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl bg-card/90 backdrop-blur-md p-3.5 shadow-xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-slide-up-and-fade',
        toneStyles[tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full',
          toneIconBg[tone],
        )}
      >
        <ToneIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-sm font-medium text-foreground">
          {t.title}
        </p>
        {t.description && <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-3 w-3"
          aria-hidden
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
