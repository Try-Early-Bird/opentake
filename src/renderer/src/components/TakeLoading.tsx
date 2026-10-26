import { useEffect, useState } from 'react';
import { StatusDot } from './chat/StatusDot';

/** A pending response must never look like an empty account. */
export function TakeLoading({ failed = false }: { failed?: boolean }): React.JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, []);
  return <div role={failed ? 'alert' : 'status'} className="px-3 py-8 text-sm text-muted-foreground">
    <p className="flex items-center gap-2.5"><StatusDot tone="attention" />{failed ? 'Could not load your Takes. Retrying…' : slow ? 'Your Takes are taking longer to load.' : 'Loading your Takes…'}</p>
    {(slow || failed) && <p className="mt-1.5 pl-4 text-xs">Still waiting for the background service. Opentake will keep trying to load your Takes.</p>}
  </div>;
}
