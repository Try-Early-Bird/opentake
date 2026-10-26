import { cn } from '../lib/utils';

import { EarlybirdMark } from '../logos';

// The brand mark and site, bottom left of every chart's plot area, faint so
// it reads as a watermark on screenshots without competing with the line.
// Each chart passes the offset that clears its own axis and bottom margin.

export function ChartWatermark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('pointer-events-none absolute left-3 z-10 inline-flex select-none items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground/70', className)}
    >
      <EarlybirdMark className="h-3 w-[10.5px] opacity-70" />
      agents.joinearlybird.com
    </span>
  );
}
