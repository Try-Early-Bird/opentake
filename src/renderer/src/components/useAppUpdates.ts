import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../shared/app-updates';

export function useAppUpdates() {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    if (!window.settings?.onUpdateState) return;
    let active = true; let receivedEvent = false;
    const off = window.settings.onUpdateState(value => { receivedEvent = true; if (active) setState(value); });
    void window.settings.updateState().then(value => { if (active && !receivedEvent) setState(value); }).catch(() => {});
    return () => { active = false; off(); };
  }, []);
  return state;
}
