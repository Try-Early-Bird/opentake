import { useEffect, useState } from 'react';
import { cn } from '../lib/utils';

// (strategies/StrategyCard). The
// hosted catalog supplied each symbol's logo URL; here the main process
// resolves and caches it locally and hands back a data: URL.

const logoSizes = {
  /** Inline with 11px chip text, e.g. the Drafts row view. */
  inline: 'size-4 text-[7px]',
  small: 'size-6 text-[9px]',
  regular: 'size-8 text-[11px]',
} as const;

const resolved = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function requestLogo(symbol: string): Promise<string | null> {
  let request = pending.get(symbol);
  if (request === undefined) {
    // A dev app whose preload predates this bridge has no such call; the chip keeps its initials.
    const load = window.portfolio.logo as typeof window.portfolio.logo | undefined;
    request = (load === undefined ? Promise.resolve(null) : load(symbol).catch(() => null)).then((url) => {
      resolved.set(symbol, url);
      pending.delete(symbol);
      return url;
    });
    pending.set(symbol, request);
  }
  return request;
}

/** Logo URLs for symbols; a symbol is absent until resolved and null when it has none. */
export function useLogos(symbols: readonly string[]): ReadonlyMap<string, string | null> {
  const key = [...symbols].sort().join(',');
  const [, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const missing = symbols.filter((symbol) => !resolved.has(symbol));
    if (missing.length === 0) return;
    void Promise.all(missing.map(requestLogo)).then(() => {
      if (!cancelled) setVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return new Map(symbols.flatMap((symbol) => resolved.has(symbol) ? [[symbol, resolved.get(symbol)!] as const] : []));
}

export function HoldingLogo({ weight, size = 'regular' }: {
  weight: { symbol: string; logoUrl: string | null };
  size?: keyof typeof logoSizes;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [weight.logoUrl]);
  const sizeClass = logoSizes[size];
  if (weight.logoUrl && !failed) {
    return <img src={weight.logoUrl} alt="" onError={() => setFailed(true)} className={cn('shrink-0 rounded-full bg-background object-cover ring-1 ring-border', sizeClass)} />;
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold uppercase text-muted-foreground ring-1 ring-border', sizeClass)} aria-hidden="true">
      {weight.symbol.slice(0, 2)}
    </span>
  );
}
