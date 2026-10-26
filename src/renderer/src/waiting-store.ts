import { useSyncExternalStore } from 'react';

// Shared open/closed state for the status bar's waiting window, so a toast
// ("View") or a screen can open it from outside the status bar.

let open = false;
const listeners = new Set<() => void>();

export function setWaitingOpen(next: boolean | ((current: boolean) => boolean)): void {
  const value = typeof next === 'function' ? next(open) : next;
  if (open === value) return;
  open = value;
  listeners.forEach((listener) => listener());
}

export function useWaitingOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}

// Bumped whenever the member acts on a queue item (confirm, cancel), so a
// screen showing the same thing -- a strategy's instruction card -- reloads
// at once instead of waiting for its own next look.
let queueVersion = 0;
const queueListeners = new Set<() => void>();

export function noteQueueActed(): void {
  queueVersion += 1;
  queueListeners.forEach((listener) => listener());
}

export function useQueueVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      queueListeners.add(listener);
      return () => queueListeners.delete(listener);
    },
    () => queueVersion,
  );
}
