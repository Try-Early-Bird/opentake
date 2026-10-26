import { useSyncExternalStore } from 'react';

// Shared open/closed state for the archive decision prompt, so a positions
// row or a notification can raise it from outside the prompt's own tree.

let open = false;
const listeners = new Set<() => void>();

export function setArchivePromptOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  listeners.forEach((listener) => listener());
}

export function useArchivePromptOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
