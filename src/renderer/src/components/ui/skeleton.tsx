import { cn } from '../../lib/utils';

/** A placeholder block in the shape of content that is still loading. Size it
 *  with className (height, width, rounding); it is hidden from assistive tech,
 *  so the loading region itself should carry the label. */
export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded bg-muted motion-reduce:animate-none', className)} />;
}
