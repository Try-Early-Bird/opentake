import { useEffect, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { ToastProvider, useToasts } from './ui/toast';
export function PlatformAccessSetting() { return <ToastProvider><PlatformAccessControl /></ToastProvider>; }
function PlatformAccessControl() {
 const [verify,setVerify]=useState<boolean>();const [busy,setBusy]=useState(false);const toast=useToasts();
 useEffect(()=>{let active=true;void window.mcp.platformSettings().then(value=>{if(active)setVerify(value.verify);}).catch(()=>toast.error('platform-settings','Could not load platform data settings.'));return()=>{active=false;};},[toast]);
 async function change(value:boolean){setBusy(true);try{const result=await window.mcp.configurePlatformAccess(value);setVerify(result.verify);toast.recover('platform-settings');}catch{toast.error('platform-settings','Could not save platform data settings.');}finally{setBusy(false);}}
 return <div className="flex items-start justify-between gap-6 py-3"><div><h3 id="platform-verification-label" className="text-sm font-medium">Verify platform data access</h3><p id="platform-verification-help" className="mt-1 max-w-xl text-sm text-muted-foreground">By default, your AI can use balances, holdings and account data shared earlier in the conversation. Turn this on to approve access for each Take and AI provider. Account credentials stay private.</p></div><Switch.Root aria-labelledby="platform-verification-label" aria-describedby="platform-verification-help" checked={verify??false} disabled={verify===undefined||busy} onCheckedChange={value=>void change(value)} className="inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-muted p-1 data-checked:bg-success disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"><Switch.Thumb className="size-5 rounded-full bg-foreground transition-transform data-checked:translate-x-5 data-checked:bg-background" /></Switch.Root></div>;
}
