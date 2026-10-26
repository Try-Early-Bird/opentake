import { ConnectionFailure } from './connection-errors';

// Serialize manual operations. Only a new sign-in supersedes another sign-in;
// replacements wait for the old callback listener and provider to finish cleanup.
export function createConnectionActions(abortProvider: () => void) {
  let active: { kind: string; controller: AbortController; done: Promise<unknown> } | undefined;
  return {
    busy: () => Boolean(active),
    async cancel() {
      const previous = active;
      previous?.controller.abort();
      await previous?.done.catch(() => {});
    },
    run<T>(kind: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const previous = active;
      if (previous && (kind !== 'connect' || previous.kind !== 'connect')) return Promise.reject(new ConnectionFailure('busy'));
      previous?.controller.abort();
      const controller = new AbortController();
      const entry = { kind, controller, done: undefined as unknown as Promise<T> };
      active = entry;
      entry.done = Promise.resolve().then(async () => {
        await previous?.done.catch(() => {});
        if (controller.signal.aborted) throw new ConnectionFailure('cancelled');
        controller.signal.addEventListener('abort', abortProvider, { once: true });
        try { return await work(controller.signal); }
        catch (error) { if (controller.signal.aborted) throw new ConnectionFailure('cancelled'); throw error; }
        finally { controller.signal.removeEventListener('abort', abortProvider); }
      }).finally(() => { if (active === entry) active = undefined; });
      return entry.done;
    },
  };
}
