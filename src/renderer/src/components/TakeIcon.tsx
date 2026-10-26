import { useEffect, useState } from 'react';

export function useTakeIcon(iconId: string | null | undefined): string | null {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (iconId) void window.takes.image(iconId).then((url) => { if (active) setImage({ id: iconId, url }); }).catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [iconId]);
  return image && image.id === iconId ? image.url : null;
}

export function TakeIcon({ iconId, className }: { iconId?: string | null; className: string }): React.JSX.Element | null {
  const url = useTakeIcon(iconId);
  return url ? <img data-slot="take-icon" src={url} alt="" className={className} /> : null;
}
