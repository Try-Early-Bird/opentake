import {useEffect} from 'react';
import {useHideCryptoDust,useCryptoDustThreshold} from './crypto-preferences';
import { ToastProvider } from './components/ui/action-toast';
import { SearchButton, SearchDialog } from './components/SearchDialog';
import { NotificationCenter } from './components/NotificationCenter';
import { ArchiveDecisionPrompt } from './components/ArchiveDecisionPrompt';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { EarlybirdMark } from './logos';
import { StatusBar } from './components/StatusBar';
import { UpdateBanner } from './components/UpdateBanner';
import { ShortcutProvider } from './shortcuts/Shortcuts';

export function AppShell(): React.JSX.Element {
  const hideDust=useHideCryptoDust(),dustThreshold=useCryptoDustThreshold();
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const sync=async()=>{try{await window.dataSources.coinbaseStream.setDustPolicy({hide:hideDust,threshold:dustThreshold});}catch{if(!disposed)timer=setTimeout(()=>void sync(),5000);}};
    void sync();return()=>{disposed=true;if(timer)clearTimeout(timer);};
  },[hideDust,dustThreshold]);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onSettings = pathname === '/settings';
  // These pages sit in the padded main.
  const marketPage=pathname.startsWith('/coinbase/');
  const padded = pathname === '/data-sources' || marketPage || pathname === '/takes' || pathname === '/portfolio' || pathname === '/activity' || pathname.startsWith('/strategies/') || (pathname.startsWith('/rh/') || pathname.startsWith('/markets/'));
  return (
    <ShortcutProvider><ToastProvider><div className="min-h-screen bg-background text-foreground">
      <header className="relative flex items-center justify-between gap-6 px-6 py-3">
        <div className="flex items-center gap-6"><Link to="/" aria-label="Opentake home" className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
          <EarlybirdMark className="h-6 w-[21px]" />
        </Link>
        <nav aria-label="Main navigation" className="flex gap-1 text-sm"><Link to="/portfolio" aria-current={pathname === "/portfolio" ? "page" : undefined} className="rounded-md px-3 py-1.5 text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground">Portfolio</Link><Link to="/takes" aria-current={pathname === "/takes" || pathname.startsWith("/strategies/") ? "page" : undefined} className="rounded-md px-3 py-1.5 text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground">Takes</Link></nav></div>
        <div className="flex items-center gap-1"><SearchButton /><NotificationCenter /></div>
      </header>
      <UpdateBanner />
      <main aria-label={pathname === '/data-sources' ? 'Data sources' : marketPage ? 'Asset' : onSettings ? 'Settings' : pathname === '/job-history' ? 'Job History' : pathname === '/activity' ? 'Activity' : pathname === '/portfolio' ? 'Portfolio' : pathname === '/takes' ? 'Takes' : pathname.startsWith('/strategies/') ? 'Take' : (pathname.startsWith('/rh/') || pathname.startsWith('/markets/')) ? 'Market' : 'Home'} className={onSettings || padded ? "w-full px-4 pt-6 pb-14 sm:px-6 md:pt-8 lg:px-8" : "w-full"}>
        <Outlet />
      </main>
      <SearchDialog />
      <StatusBar />
      <ArchiveDecisionPrompt />
    </div></ToastProvider></ShortcutProvider>
  );
}
