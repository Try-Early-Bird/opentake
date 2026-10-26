import { Menu } from '@base-ui/react/menu';
import { Binoculars, Check, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { Watchlist, WatchlistItemInput, WatchlistMembership } from '../../../shared/watchlists';
import { cn } from '../lib/utils';
import { announceWatchlistsChanged, useListRefresh, useWatchlists } from '../watchlists';
import { CreateListDialog } from './CreateListDialog';

// "Add to list" for a market page or a take (after the hosted
// desktop app): binoculars that turn brand-colored when the target is on any
// list, opening a menu with a check per list. Robinhood's curated lists are
// read-only, so they are left out. "New list" opens the same dialog as the
// Lists panel and adds the target to the list it creates.

const itemClass = 'flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-xs outline-none data-[highlighted]:bg-muted disabled:opacity-50';

export function AddToListMenu({ target, className }: { target: WatchlistItemInput; className?: string }): React.JSX.Element {
  const { lists, reload } = useWatchlists();
  // Where the target sits, asked directly: lists carry no items.
  const [members, setMembers] = useState<WatchlistMembership[]>([]);
  const targetKey = JSON.stringify(target);
  const loadMembers = useCallback(async () => {
    try { setMembers(await window.watchlists.membership(JSON.parse(targetKey) as WatchlistItemInput)); } catch { setMembers([]); }
  }, [targetKey]);
  useEffect(() => { void loadMembers(); }, [loadMembers]);
  useListRefresh(useCallback(() => void loadMembers(), [loadMembers]));
  const memberOf = (list: Watchlist) => members.find((member) => member.listId === list.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const onAny = members.length > 0;
  const eligible = (lists ?? []).filter((list) => list.mirror?.ownerType !== 'curated');

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await Promise.all([reload(), loadMembers()]);
      announceWatchlistsChanged();
    } catch {
      setError('Could not update your lists.');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (list: Watchlist): Promise<void> => {
    const existing = memberOf(list);
    return run(() => existing ? window.watchlists.removeItem(list.id, existing.itemId) : window.watchlists.addItem(list.id, target));
  };
  const addToCreated = (list: Watchlist): Promise<void> => run(() => window.watchlists.addItem(list.id, target));

  return (
    <>
    <Menu.Root>
      <Menu.Trigger
        aria-label={onAny ? 'On your lists. Edit lists' : 'Add to list'}
        title={onAny ? 'On your lists' : 'Add to list'}
        className={cn('flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted data-[popup-open]:bg-muted', className)}
      >
        <Binoculars size={16} strokeWidth={onAny ? 2.5 : 2} className={cn(onAny && 'text-brand')} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} collisionPadding={12} className="z-[100]">
          <Menu.Popup className="w-60 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">Add to list</p>
            {lists === null ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
            ) : eligible.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No lists yet</p>
            ) : eligible.map((list) => {
              const checked = memberOf(list) !== undefined;
              return (
                <Menu.CheckboxItem
                  key={list.id}
                  checked={checked}
                  disabled={busy}
                  closeOnClick={false}
                  onCheckedChange={() => void toggle(list)}
                  className={itemClass}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    <Menu.CheckboxItemIndicator><Check size={13} aria-hidden="true" /></Menu.CheckboxItemIndicator>
                  </span>
                  <span aria-hidden="true">{list.iconEmoji ?? '💡'}</span>
                  <span className="truncate">{list.name}</span>
                </Menu.CheckboxItem>
              );
            })}
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item disabled={busy} onClick={() => setCreating(true)} className={itemClass}>
              <Plus size={13} className="text-muted-foreground" aria-hidden="true" />New list
            </Menu.Item>
            {error && <p role="alert" className="px-3 py-1.5 text-xs text-destructive">{error}</p>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
    <CreateListDialog open={creating} onOpenChange={setCreating} onCreated={addToCreated} />
    </>
  );
}
