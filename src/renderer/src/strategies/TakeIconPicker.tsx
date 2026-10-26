import { ImagePlus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { useTakeIcon } from '../components/TakeIcon';

export function TakeIconPicker({ takeId, iconId, readOnly, onChanged }: {
  takeId: string; iconId?: string | null; readOnly: boolean; onChanged: (id: string | null) => void;
}): React.JSX.Element | null {
  const input = useRef<HTMLInputElement>(null);
  const url = useTakeIcon(iconId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(file: File | null): Promise<void> {
    setBusy(true); setError(null);
    try {
      let id: string | null = null;
      if (file) {
        if (file.size > 2 * 1024 * 1024) throw new Error('Choose an image up to 2 MB.');
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error('Could not read this image.'));
          reader.readAsDataURL(file);
        });
        id = (await window.takes.upload(takeId, file.name, base64)).id;
      }
      await window.takes.update(takeId, { iconId: id });
      onChanged(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the icon.'); }
    finally { setBusy(false); }
  }
  if (readOnly) return url ? <img src={url} alt="" className="size-10 shrink-0 rounded-lg object-cover" /> : null;
  return <div className="shrink-0">
    <div className="flex items-center gap-1">
      <Button size="icon" variant="ghost" disabled={busy} aria-label={iconId ? 'Change take icon' : 'Add take icon'} title={iconId ? 'Change take icon' : 'Add take icon'} onClick={() => input.current?.click()}>
        {url ? <img src={url} alt="" className="size-9 rounded-lg object-cover" /> : <ImagePlus size={18} aria-hidden="true" />}
      </Button>
      {iconId && <Button size="icon-sm" variant="ghost" disabled={busy} aria-label="Remove take icon" title="Remove take icon" onClick={() => void save(null)}><Trash2 size={13} aria-hidden="true" /></Button>}
    </div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose take icon" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void save(file); }} />
    {error && <p role="alert" className="mt-1 max-w-32 text-xs text-destructive">{error}</p>}
  </div>;
}
