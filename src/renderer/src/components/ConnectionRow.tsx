import type { ReactNode } from 'react';

export function ConnectionRow({ name, logo, connected, description, children }: {
  name: string; logo: ReactNode; connected?: boolean; description: ReactNode; children: ReactNode;
}) {
  return <li className="flex items-center gap-3 py-2">
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center">{logo}</span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{name}</span>
        {connected && <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 [.dark_&]:text-green-400"><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />Connected</span>}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </div>
    {children}
  </li>;
}

export const connectionActionClass = 'shrink-0 rounded-full bg-muted px-4 py-2 text-sm font-medium hover:bg-muted/80 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
export const connectionDisconnectClass = 'shrink-0 rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
