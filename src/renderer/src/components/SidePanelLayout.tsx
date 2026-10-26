import { cn } from '../lib/utils';

// The two-column page with a right-hand rail, shared by every screen that has
// one so the rail keeps the same width, gap, and breakpoint from page to page.
// Below `lg` the rail stacks under the main column. The default window is
// 1200px wide, so the rail sits beside the content whenever the window is at
// its default size or larger.

export function SidePanelLayout({ aside, sticky = false, asideClassName, className, children }: {
  /** The rail's content. When null the main column is laid out alone at the
   *  same width it would have beside a rail. */
  aside: React.ReactNode;
  /** Pin the rail while the main column scrolls. Only use this for a rail
   *  that is shorter than the window. */
  sticky?: boolean;
  asideClassName?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
      <div className={cn('min-w-0', className)}>{children}</div>
      {aside !== null && (
        <aside className={cn('mt-8 min-w-0 lg:mt-0', asideClassName)}>
          {sticky ? <div className="lg:sticky lg:top-6">{aside}</div> : aside}
        </aside>
      )}
    </div>
  );
}
