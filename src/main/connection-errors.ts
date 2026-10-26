export class ConnectionFailure extends Error {
  constructor(readonly code: 'reauth_required' | 'storage_locked' | 'transient' | 'cancelled' | 'busy') { super(code); }
}
export function connectionFailure(error: unknown, signal?: AbortSignal): ConnectionFailure {
  if (signal?.aborted) return new ConnectionFailure('cancelled');
  if (error instanceof ConnectionFailure) return error;
  // Only structured names/codes, never persist or expose provider error text.
  const value = error as { name?: string; error?: string; code?: string | number } | null;
  if (value?.error === 'invalid_grant' || value?.name === 'InvalidGrantError' || value?.name === 'UnauthorizedError' || value?.code === 401) {
    return new ConnectionFailure('reauth_required');
  }
  return new ConnectionFailure('transient');
}
