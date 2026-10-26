import { useEffect, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { setHideCryptoDust, useHideCryptoDust, useCryptoDustThreshold, setCryptoDustThreshold, normalizeDustThreshold } from '../crypto-preferences';
export function CryptoSettings() {
 const hide=useHideCryptoDust();
 const threshold=useCryptoDustThreshold();
 const [draft,setDraft]=useState(threshold);
 const [error,setError]=useState('');
 useEffect(()=>{setDraft(threshold);},[threshold]);
 function save() {
  const normalized=normalizeDustThreshold(draft);
  if(normalized===null){setError('Enter an amount of $0 or more, with up to two decimal places.');return;}
  setCryptoDustThreshold(normalized);setDraft(normalized);setError('');
 }
 return <section aria-labelledby="crypto-heading" className="space-y-6">
  <h2 id="crypto-heading" className="text-lg font-medium">Crypto</h2>
  <div className="space-y-2">
   <div className="flex items-center justify-between gap-4">
    <label htmlFor="hide-crypto-dust">Hide small balances</label>
    <Switch.Root id="hide-crypto-dust" checked={hide} onCheckedChange={setHideCryptoDust}
     className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 transition-colors data-checked:bg-primary focus-visible:outline-2 focus-visible:outline-ring">
     <Switch.Thumb className="size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4" />
    </Switch.Root>
   </div>
   <p className="text-sm text-muted-foreground">Hide holdings worth less than your threshold. They still count toward your portfolio balance.</p>
  </div>
  <div className="space-y-2">
   <div className="flex items-center justify-between gap-4">
    <label htmlFor="crypto-dust-threshold">Minimum holding value (USD)</label>
    <input id="crypto-dust-threshold" type="text" inputMode="decimal" value={draft}
     aria-invalid={!!error} aria-describedby={error?'crypto-dust-error':'crypto-dust-help'}
     onChange={event=>{setDraft(event.target.value);setError('');}} onBlur={save}
     onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}
     className="h-9 w-28 rounded-md border border-input bg-background px-3 text-right text-sm focus-visible:outline-2 focus-visible:outline-ring" />
   </div>
   <p id="crypto-dust-help" className="text-sm text-muted-foreground">Default: $0.10. Changes save automatically.</p>
   {error&&<p id="crypto-dust-error" role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
 </section>;
}
