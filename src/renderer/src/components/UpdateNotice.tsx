import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAppUpdates } from './useAppUpdates';

export function UpdateNotice() {
  const state = useAppUpdates();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState('');
  const key = `${state?.version}:${state?.status}`;
  if (!state?.version || !['available', 'ready'].includes(state.status) || dismissed === key) return null;
  return <div role="status" className="mr-2 flex items-center gap-2 text-xs">
    <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => void navigate({ to: '/settings', search: { section: 'general' } })}>
      {state.status === 'ready' ? `Restart to update to ${state.version}` : `Version ${state.version} available`}
    </button>
    <button type="button" aria-label="Dismiss update notice" className="px-1 text-muted-foreground" onClick={() => setDismissed(key)}>×</button>
  </div>;
}
