import { createHash, randomBytes } from 'node:crypto';

// Capabilities are host-memory only. The public run ID never authorizes a call.
export function createRunCapabilities(active: (runId: string) => boolean, now = Date.now) {
  const grants = new Map<string, { runId: string; takeId: string; expiresAt: number }>();
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  return {
    issue(runId: string, takeId: string, ttlMs = 10 * 60_000) {
      const token = randomBytes(32).toString('hex');
      grants.set(digest(token), { runId, takeId, expiresAt: now() + ttlMs });
      return { token, revoke: () => { grants.delete(digest(token)); } };
    },
    authorize(token: string, method: string, args: unknown[]) {
      if (!/^[a-f0-9]{64}$/.test(token)) return false;
      const grant = grants.get(digest(token));
      return !!grant && grant.expiresAt > now() && active(grant.runId)
        && (method === 'gateway:instructions' || method === 'gateway:list' || method === 'gateway:call') && args[0] === grant.runId;
    },
  };
}
