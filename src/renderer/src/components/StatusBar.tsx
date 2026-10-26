import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Keyboard, Settings } from 'lucide-react';
import { useShortcuts } from '../shortcuts/Shortcuts';
import { cn } from '../lib/utils';
import { Popover } from '@base-ui/react/popover';
import { commands, displayBinding } from '../shortcuts/registry';
import { ActivityQueue } from './ActivityQueue';
import { ConnectMenu } from './ConnectMenu';
import { UpdateNotice } from './UpdateNotice';

export function StatusBar(): React.JSX.Element {
  const navigate = useNavigate();
  const { summary, setSummary, bindings } = useShortcuts();
  const onSettings = useRouterState({ select: (state) => state.location.pathname === '/settings' });
  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 flex h-7 items-center justify-end gap-0.5 border-t border-border bg-background px-3">
      <div className="mr-auto"><ConnectMenu /></div>
      <UpdateNotice />
      <ActivityQueue />
      <Popover.Root open={summary} onOpenChange={setSummary} modal={false} triggerId="shortcut-summary-trigger">
        <Popover.Trigger id="shortcut-summary-trigger" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><Keyboard size={16} aria-hidden="true" /></Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50">
            <Popover.Popup data-slot="popover-content" className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--available-height)] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
              <Popover.Title className="font-medium">Keyboard shortcuts</Popover.Title>
              <Popover.Description className="mt-1 text-xs text-muted-foreground">Current bindings on this device.</Popover.Description>
              <dl className="my-3 divide-y divide-border">{commands.map(command => <div key={command.id} className="flex items-center justify-between gap-3 py-2"><dt className="text-xs">{command.label}</dt><dd className="shrink-0"><kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">{displayBinding(bindings[command.id])}</kbd></dd></div>)}</dl>
              <button type="button" className="w-full rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setSummary(false); void navigate({ to: '/settings', search: { section: 'shortcuts' } }); }}>Edit shortcuts</button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        onClick={() => void navigate({ to: onSettings ? '/' : '/settings' })}
        aria-label="Settings"
        aria-pressed={onSettings}
        title={onSettings ? 'Close settings' : 'Settings'}
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
          onSettings && 'bg-muted text-foreground',
        )}
      >
        <Settings size={16} aria-hidden="true" />
      </button>
    </footer>
  );
}
