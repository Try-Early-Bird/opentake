import EmojiPicker, { EmojiStyle, SkinTonePickerLocation, Theme, type EmojiClickData } from 'emoji-picker-react';
import { useEffect, useState } from 'react';

import type { Watchlist } from '../../../shared/watchlists';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

// "New list" form behind the + in the Lists panel and the Add to list menu
// (as in Earlybird's desktop app): a name plus an emoji icon from a
// searchable picker. Native glyphs, since the renderer's CSP blocks image
// CDNs and Robinhood's list icons are standard emoji anyway.

export const DEFAULT_LIST_EMOJI = '💡';

export function CreateListDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (list: Watchlist) => void | Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(DEFAULT_LIST_EMOJI);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmoji(DEFAULT_LIST_EMOJI);
    setPickerOpen(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const pickEmoji = (data: EmojiClickData): void => {
    setEmoji(data.emoji);
    setPickerOpen(false);
  };

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const list = await window.watchlists.create({ name: trimmed, iconEmoji: emoji });
      await onCreated(list);
      onOpenChange(false);
    } catch {
      setError('Could not create the list.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
            <DialogDescription>Pick an icon and a name.</DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              aria-label={`List icon: ${emoji}. Change icon`}
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((value) => !value)}
              className={cn(
                'flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-2xl leading-none hover:ring-2 hover:ring-border',
                pickerOpen && 'ring-2 ring-brand',
              )}
            >
              {emoji}
            </button>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="List name"
              aria-label="List name"
              maxLength={64}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="h-11 w-full rounded-md border border-border bg-transparent px-3 text-sm outline-none focus:border-foreground/40"
            />
          </div>

          {pickerOpen && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <EmojiPicker
                onEmojiClick={pickEmoji}
                emojiStyle={EmojiStyle.NATIVE}
                theme={document.documentElement.classList.contains('dark') ? Theme.DARK : Theme.LIGHT}
                skinTonePickerLocation={SkinTonePickerLocation.PREVIEW}
                previewConfig={{ showPreview: false }}
                width="100%"
                height={320}
                lazyLoadEmojis
                autoFocusSearch={false}
              />
            </div>
          )}

          {error !== null && <p role="alert" className="mt-4 text-xs text-error">{error}</p>}

          <DialogFooter className="mt-5">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || name.trim() === ''}>{busy ? 'Creating…' : 'Create list'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
