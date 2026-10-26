import {beginPortfolioRange,measurePortfolioSnapshot} from '../portfolio-render-probe';
import {isCryptoDust,useHideCryptoDust,useCryptoDustThreshold} from '../crypto-preferences';
import { CoinbasePositionRows } from '../components/CoinbasePositionRows';
import { PortfolioAccountSelect } from '../components/PortfolioAccountSelect';
import { Link } from '@tanstack/react-router';
import { Info, RefreshCw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { money, signedMoney } from '../portfolio/format';
import { Button } from '../components/ui/button';
import { PortfolioChart, type PortfolioHoverPoint } from '../components/PortfolioChart';
import { ActivityRows } from '../components/ActivityRows';
import { PositionRows } from '../components/PositionRows';
import { RollingNumber } from '../components/RollingNumber';
import { SidePanelLayout } from '../components/SidePanelLayout';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../components/ui/app-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { CoinbaseMark, RobinhoodLogoTile } from '../logos';
import { chartTradingDay, classifySession, extendedSessionLabels, SERIES_RETRY_MS, SERIES_RETRY_LIMIT, type MarketSeries } from '../market-series';
import type { PortfolioRange } from '../portfolio-history';
import type { AllocationHistory, PortfolioAccount, PortfolioView } from '../../../shared/portfolio';
import { historyFromPerformance, historyRangeFor } from '../portfolio/strategy-series';
import { freeBuyingPower } from '../portfolio/free-buying-power';
import { portfolioPoints, portfolioHoldings, portfolioActivity, positionSeries } from '../portfolio/local-adapter';
import { ListsPanel } from '../components/ListsPanel';

const ranges: readonly PortfolioRange[] = ['1d', '1w', '1m', '3m', '1y'];

// Matches the web dashboard: the change is shown over the selected period.
const changePeriodLabels: Record<PortfolioRange, string> = {
  '1d': 'Today',
  '1w': 'Past Week',
  '1m': 'Past Month',
  '3m': 'Past 3 Months',
  '1y': 'Past Year',
  all: 'All Time',
};

// The view and display components
// retain the original layout; local observations replace hosted account APIs.
export function Portfolio(): React.JSX.Element {
  const [selectedAccount, setSelectedAccount] = useState<string | null>(() => { try { return localStorage.getItem('portfolio-view-account'); } catch { return null; } });
  const selectedRef = useRef(selectedAccount); selectedRef.current = selectedAccount;
  const [accounts, setAccounts] = useState<PortfolioAccount[]>([]);
  const [view, setView] = useState<PortfolioView | null>(null);
  const [range, setRange] = useState<PortfolioRange>('1d');
  const [marketSeries,setMarketSeries]=useState<{accountId:string;data:MarketSeries}|null>(null);
  const [seriesPending,setSeriesPending]=useState(false);
  const [seriesError,setSeriesError]=useState(false);
  const [seriesRefresh,setSeriesRefresh]=useState(0);
  const [pending, setPending] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [connectStatus, setConnectStatus] = useState<'idle'|'connecting'|'error'>('idle');
  const [connectMessage, setConnectMessage] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [hoverPoint, setHoverPoint] = useState<PortfolioHoverPoint | null>(null);
  const [buyingPowerTipOpen, setBuyingPowerTipOpen] = useState(false);
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const load = useCallback(async () => {
    const choice = selectedAccount;
    const next = await measurePortfolioSnapshot(()=>window.portfolio.snapshot(choice ?? undefined));
    if (mounted.current && selectedRef.current === choice) { setAccounts(next.accounts); setView(next); setPending(false); setError(''); }
    return next;
  }, [selectedAccount]);
  const chooseAccount = (id: string) => {
    selectedRef.current = id; setSelectedAccount(id);
    try { localStorage.setItem('portfolio-view-account', id); } catch { /* Preference storage may be unavailable. */ }
    setView(null); setPending(true); setHoverPoint(null); setMarketSeries(null); setHistoryByAllocation(new Map());
    setMessage(''); setError(''); setSyncing(false); setDisconnectDialogOpen(false);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const poll = async () => {
      try {
        const next = await load();
        if (!active || selectedRef.current !== selectedAccount) return;
        const running = next.resources.some(r => r.state === 'running');
        setSyncing(running);
        if (next.resources.length && next.resources.every(r => r.state === 'completed' && !r.stale)) setMessage('');
        if ((next.account?.selected || next.account?.venue === 'coinbase') && next.account.available && !requested.current.has(next.account.id)
          && (!next.resources.length || next.resources.some(r => r.stale))) {
          requested.current.add(next.account.id);
          await window.portfolio.refresh(next.account.id);
          if (active && selectedRef.current === selectedAccount) { setMessage(next.account.venue === 'coinbase' ? 'Portfolio updated.' : 'Refresh requested. Waiting for the latest account data.'); await load(); }
        }
      } catch { if (active) { setPending(false); setError('Portfolio could not be updated. Check your connection and try again.'); } }
    };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; mounted.current = false; clearInterval(timer); };
  }, [load]);
  const synchronize = async () => {
    if (!view?.account?.available || (!view.account.selected && view.account.venue !== 'coinbase')) return;
    const origin = selectedRef.current;
    setSyncing(true); setSeriesRefresh(value=>value+1);
    try { await window.portfolio.refresh(view.account.id); if (selectedRef.current !== origin) return; setMessage(view.account.venue === 'coinbase' ? 'Portfolio updated.' : 'Refresh requested. Waiting for the latest account data.'); await load(); }
    catch { if (selectedRef.current === origin) setError('Could not refresh your portfolio. Check your connection and try again.'); }
    finally { if (mounted.current && selectedRef.current === origin) setSyncing(false); }
  };
  const connect = async () => {
    setConnectStatus('connecting'); setConnectMessage('');
    try {
      const result = await window.connections.connect();
      if (!mounted.current) return;
      if (!result.ok) { setConnectStatus('error'); setConnectMessage(result.message); return; }
      setConnectStatus('idle'); await load();
      if (!result.connection.accounts.some(a => a.selected)) setConnectMessage('Select an eligible account in Connections to begin syncing.');
    } catch { if (mounted.current) { setConnectStatus('error'); setConnectMessage('Connection failed. Please try again.'); } }
  };
  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const result = await window.connections.disconnect();
      if (!result.ok) { setError(result.message); return; }
      setHoverPoint(null); setMessage(''); await load(); setDisconnectDialogOpen(false);
    } catch { setError('Could not disconnect. Please try again.'); }
    finally { if (mounted.current) setDisconnecting(false); }
  };
  const account = view?.account?.available ? {
    accountId: view.account.id, venueDisplayName: view.account.venue === 'robinhood' ? 'Robinhood' : 'Coinbase',
    asOf: view.resources.find(r => r.resource === (view.account?.venue === 'coinbase' ? 'portfolio' : 'equity_positions'))?.observedAt,
    summary: { totalAssetValue: view.portfolio?.totalValue, buyingPower: view.portfolio?.buyingPower, cash: view.portfolio?.cash },
  } : null;
  const hideCryptoDust=useHideCryptoDust(),cryptoDustThreshold=useCryptoDustThreshold();
  const isCoinbase = view?.account?.venue === 'coinbase';
  const currency = view?.portfolio?.currency ?? 'USD';
  const points = useMemo(() => portfolioPoints(view, range), [view, range]);
  const holdings = useMemo(() => portfolioHoldings(view?{...view,positions:view.selfDirectedPositions??view.positions}:null), [view]);
  const seriesAccountId=(view?.account?.selected||isCoinbase)&&view?.account?.available?view.account.id:null;
  const seriesKey=isCoinbase?(view?.spotPositions??[]).filter(p=>!p.isCash&&(!hideCryptoDust||!isCryptoDust(p.marketValue,p.currency,cryptoDustThreshold))).map(p=>p.asset).sort().join(','):(view?.positions??[]).filter(p=>p.assetClass==='equity').map(p=>p.symbol).sort().join(',');
  useEffect(()=>{
    let cancelled=false;let timer:ReturnType<typeof setTimeout>|undefined;let retries=0;let seriesBusy=false;
    setMarketSeries(null);setSeriesError(false);
    if(!seriesAccountId||!seriesKey){setSeriesPending(false);return;}
    const loadSeries=async()=>{
      if(cancelled||seriesBusy)return;seriesBusy=true;
      setSeriesPending(true);
      try{
        const data=await window.dataSources.marketSeries(seriesAccountId,range,isCoinbase?seriesKey.split(','):undefined);
        if(cancelled)return;
        setMarketSeries({accountId:seriesAccountId,data});setSeriesError(false);
        if((data.pendingSymbols.length||data.refreshingSymbols.length)&&retries++<SERIES_RETRY_LIMIT)
          timer=setTimeout(()=>void loadSeries(),SERIES_RETRY_MS);
      }catch{if(!cancelled)setSeriesError(true);}
      finally{seriesBusy=false;if(!cancelled)setSeriesPending(false);}
    };
    void loadSeries();
    const onFocus=()=>{retries=0;if(timer)clearTimeout(timer);void loadSeries();};
    window.addEventListener('focus',onFocus);
    const refreshTimer=isCoinbase?setInterval(()=>{if(!document.hidden)onFocus();},60000):undefined;
    return()=>{cancelled=true;if(timer)clearTimeout(timer);clearInterval(refreshTimer);window.removeEventListener('focus',onFocus);};
  },[seriesAccountId,seriesKey,range,seriesRefresh,isCoinbase]);
  const shownSeries=marketSeries?.accountId===seriesAccountId&&marketSeries.data.range===range?marketSeries.data:null;
  const seriesBySymbol = useMemo(() => {
    const mapped=positionSeries(view,range);
    const bySymbol=new Map(shownSeries?.series.map(s=>[s.symbol,s])??[]);
    for(const p of view?.positions??[]){
      if(p.assetClass!=='equity'||!p.symbol)continue;
      const series=bySymbol.get(p.symbol.toUpperCase());
      if(series)mapped.set(`${p.assetClass}:${p.instrumentRef}`,series);
    }
    return mapped;
  }, [view,range,shownSeries]);
  const [allCapitalActivity,setAllCapitalActivity]=useState(false);
  const activity = useMemo(() => portfolioActivity(view), [view]);
  // Strategy rows compose 1D from the same per-symbol series, keyed by symbol.
  const strategySeriesBySymbol = useMemo(() => new Map(shownSeries?.series.map(s=>[s.symbol.toUpperCase(),s])??[]), [shownSeries]);
  // Daily allocation values back the strategy rows for every range but 1D.
  const [historyByAllocation, setHistoryByAllocation] = useState<Map<string, AllocationHistory>>(new Map());
  const strategyRowKey = (view?.strategies ?? []).map(s => `${s.allocationId}:${s.strategyId}:${isCoinbase?s.value??'':''}`).join(',');
  useEffect(() => {
    const historyRange = historyRangeFor(range);
    if (historyRange === null || !strategyRowKey) {
      setHistoryByAllocation(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(strategyRowKey.split(',').map(async (key) => {
      const [id, strategyId, value] = key.split(':') as [string, string, string];
      try { return [id, isCoinbase ? historyFromPerformance(id, historyRange, await window.strategies.performance(strategyId, historyRange, 'actual'), value || null) : await window.portfolio.strategyHistory(id, historyRange)] as const; }
      catch { return [id, null] as const; }
    })).then((entries) => {
      if (cancelled) return;
      setHistoryByAllocation(new Map(entries.flatMap(([id, history]) => history === null ? [] : [[id, history] as const])));
    });
    return () => { cancelled = true; };
  }, [range, strategyRowKey, seriesRefresh, isCoinbase]);
  const capabilities = view?.account?.accountType === 'limited_margin' ? ['Limited margin'] : view?.account?.accountType === 'margin' ? ['Margin'] : [];
  const optionLevel=view?.account?.optionLevel?.match(/option_level_(\d)/u)?.[1];
  if(optionLevel!==undefined && optionLevel!=='0') capabilities.push(`Options level ${optionLevel}`);
  const positionsReady = (isCoinbase ? ['portfolio'] : ['equity_positions','option_positions']).every(resource => view?.resources.some(r => r.resource === resource && r.observedAt));
  const failed = view?.resources.some(r => r.state === 'failed');
  const stale = view?.resources.some(r => r.stale);
  const changes = useMemo(() => {
    if (points.length < 2) return null;
    const first = Number(points[0]?.totalAssetValue);
    const lastPoint = points.at(-1)!;
    const last = hoverPoint?.value ?? Number(lastPoint.totalAssetValue);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
    const delta = (from: number, to: number, label: string) =>
      ({ amount: to - from, percent: ((to - from) / from) * 100, label });
    // While scrubbing the chart, show just the amount and percent for the
    // hovered point -- no "Today"/"Past X" label.
    const single = { primary: delta(first, last, hoverPoint !== null ? '' : (isCoinbase ? (range === '1d' ? 'Past 24h' : changePeriodLabels[range]) : changePeriodLabels[range])), secondary: null };
    if (range !== '1d' || hoverPoint !== null || isCoinbase) return single;

    const lastMs = Date.parse(lastPoint.observedAt);
    const day = chartTradingDay(lastMs);
    const session = classifySession(lastMs);
    if (session === 'regular') return single;
    if (lastMs < day.regularOpenMs) {
      // Before the open the day holds only overnight/pre-market trading.
      return { primary: delta(first, last, extendedSessionLabels[session]), secondary: null };
    }
    const closePoint = [...points].reverse()
      .find((point) => Date.parse(point.observedAt) <= day.regularCloseMs);
    const closeValue = Number(closePoint?.totalAssetValue);
    if (!Number.isFinite(closeValue) || closeValue === 0) {
      // The whole window is extended-hours (no regular-close point): label
      // the single change by session rather than calling it "Today".
      return { primary: delta(first, last, extendedSessionLabels[session]), secondary: null };
    }
    return {
      primary: delta(first, closeValue, 'Today'),
      secondary: delta(closeValue, last, extendedSessionLabels[session]),
    };
  }, [points, hoverPoint, range, isCoinbase]);
  const selector = <PortfolioAccountSelect accounts={accounts} value={selectedAccount ?? view?.account?.id ?? null} onChange={chooseAccount} loading={pending && accounts.length === 0}/>;
  if (pending && account === null) {
    return <div className="space-y-6">{selector}<div className="h-[32rem] animate-pulse rounded-xl bg-muted" aria-label="Loading portfolio"/></div>;
  }
  if (account === null && (accounts.length > 0 || selectedAccount)) {
    return <SidePanelLayout aside={<ListsPanel />}><section className="space-y-6">{selector}<div className="rounded-xl border border-border px-6 py-10"><p className="text-sm font-medium">{selectedAccount ? 'Account unavailable' : 'Choose an account'}</p><p className="mt-2 text-sm text-muted-foreground">Choose an account above, or manage its connection to continue.</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<Link to="/settings" search={{ section: 'connections' }} className="mt-4 inline-block text-sm underline">Manage connections</Link></div></section></SidePanelLayout>;
  }

  if (account === null) {
    return (
      <SidePanelLayout aside={<ListsPanel />}>
      <section className="flex min-h-80 flex-col items-center justify-center text-center">
        <RobinhoodLogoTile className="mb-5 size-12" markClassName="size-6" />
        <h1 className="text-2xl font-medium tracking-[-0.035em]">Connect your Robinhood Agentic account</h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          Your portfolio will show account value history and holdings after the
          first portfolio sync.
        </p>
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <Button
          className="mt-6"
          onClick={() => void connect()}
          disabled={connectStatus === 'connecting'}
        >
          {connectStatus === 'connecting' ? 'Waiting for Robinhood…' : 'Connect Robinhood'}
        </Button>
        {connectStatus === 'connecting' && (
          <p className="mt-4 text-sm text-muted-foreground">
            Finish signing in with Robinhood in your browser.
          </p>
        )}
        {connectMessage && (
          <p className="mt-4 text-sm text-destructive">{connectMessage}</p>
        )}
        <Link to="/settings" search={{section:"connections"}} className="mt-4 text-sm underline">Manage connections</Link>
      </section>
      </SidePanelLayout>
    );
  }

  return (
    <>
    <SidePanelLayout aside={<ListsPanel />} className="space-y-10">
      <section aria-labelledby="portfolio-value-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {selector}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                {isCoinbase ? <CoinbaseMark size={16} className="size-4 shrink-0" /> : <RobinhoodLogoTile className="size-4" markClassName="size-2.5" />}
                {account.venueDisplayName}
              </span>
              {capabilities.map((capability) => (
                <span key={capability} className="inline-flex items-center rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                  {capability}
                </span>
              ))}
            </div>
            <p className="font-display mt-1 text-[32px] tracking-[-0.03em]">
              <RollingNumber value={hoverPoint === null && account.summary.totalAssetValue == null ? "—" : money(hoverPoint?.value ?? account.summary.totalAssetValue, currency)} />
            </p>
            {/* Always render two change slots so the chart below doesn't shift
                when the extended-hours ("Overnight"/"After-hours") line appears. */}
            {[changes?.primary ?? null, changes?.secondary ?? null].map((change, index) => (
              <p
                key={index}
                aria-hidden={change === null ? true : undefined}
                className={cn(
                  'mt-1 min-h-[1.5em] text-[13px] font-medium',
                  change === null ? 'invisible' : change.amount >= 0 ? 'text-success' : 'text-error',
                )}
              >
                {change !== null && (
                  <>
                    <RollingNumber value={`${signedMoney(change.amount, currency)} (${Math.abs(change.percent).toFixed(2)}%)${!isCoinbase && change.label ? ` ${change.label}` : ''}`} />
                    {isCoinbase && change.label && <span className="ml-2 inline-flex items-center gap-1 align-middle font-normal text-muted-foreground">
                      {change.label}
                      <Tooltip>
                        <TooltipTrigger render={<button type="button" aria-label="About balance change" className="inline-flex size-6 items-center justify-center rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring" />}><Info size={12} aria-hidden="true"/></TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          <p className="font-medium">Balance change, {range === '1d' ? 'past 24 hours' : changePeriodLabels[range].toLowerCase()}</p>
                          <p className="mt-1">Compares your Coinbase balance now with {range === '1d' ? '24 hours ago' : 'the start of this period'}, so deposits and withdrawals count too — not just price moves.</p>
                          <p className="mt-1">If less history is available, uses your first sync in this period.</p>
                          {range !== '1d' && view?.coinbaseHistory?.dailyValuation === 'complete' && <p className="mt-1">Earlier daily values are estimates reconstructed from transactions and daily prices. Dated spot prices do not identify an exact intraday time.</p>}
                          {view?.coinbaseHistory && !(range !== '1d' && view.coinbaseHistory.dailyValuation === 'complete') && <p className="mt-1">{view.coinbaseHistory.state === 'complete' ? view.coinbaseHistory.valuation === 'complete' ? 'Earlier points are reconstructed from transactions and hourly market prices.' : coinbaseValuationMessage(view.coinbaseHistory.valuationIssue) : view.coinbaseHistory.issue === 'access' ? 'Coinbase did not grant transaction-history access for this key. The chart uses saved balance snapshots.' : 'Transaction history is incomplete. The chart uses saved balance snapshots.'}</p>}
                        </TooltipContent>
                      </Tooltip>
                    </span>}
                  </>
                )}
              </p>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" aria-label="Sync latest portfolio" onClick={() => void synchronize()} disabled={syncing || (!view?.account?.selected && !isCoinbase)} />}
              >
                <RefreshCw size={16} className={pending || syncing ? 'animate-spin' : undefined} />
              </TooltipTrigger>
              <TooltipContent>Sync from {account.venueDisplayName}</TooltipContent>
            </Tooltip>
            {!isCoinbase && <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" aria-label="Disconnect Robinhood" onClick={() => setDisconnectDialogOpen(true)} disabled={disconnecting || !view?.account?.selected} />}
              >
                <Unplug size={16} className={disconnecting ? 'animate-pulse' : undefined} />
              </TooltipTrigger>
              <TooltipContent>Disconnect Robinhood</TooltipContent>
            </Tooltip>}
          </div>
        </div>

        <div className="mt-6 overflow-hidden">
          {/* Chart height tracks the window so a maximized app fills vertical
              real estate; clamp keeps it usable at the 640px minimum height. */}
          <div className="h-[clamp(16rem,48vh,36rem)] pt-3">
            {points.length > 0 ? (
              <PortfolioChart continuous={isCoinbase} points={points} currency={currency} range={range} onHoverPoint={setHoverPoint} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Portfolio history will appear after snapshots are collected.
              </div>
            )}
          </div>
          <div className="flex items-center justify-start gap-1 py-3">
            {ranges.map((candidate) => (
              <Button
                key={candidate}
                aria-pressed={candidate === range}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  'h-8 rounded-none border-b-2 text-sm uppercase hover:bg-transparent',
                  candidate === range
                    ? 'border-brand font-semibold text-brand'
                    : 'border-transparent text-muted-foreground',
                )}
                onClick={() => {
                  if(candidate!==range)beginPortfolioRange(candidate);
                  setHoverPoint(null);
                  setRange(candidate);
                }}
              >
                {candidate}
              </Button>
            ))}
          </div>
          {!isCoinbase && (account.summary.buyingPower ?? account.summary.cash) != null && (() => {
            const reserved = view?.reservedCash ?? '0';
            const free = freeBuyingPower(account.summary.buyingPower ?? account.summary.cash, reserved);
            const reservedShown = Number(reserved) > 0;
            return (
              <div className="flex items-center justify-between border-y border-border py-4 text-sm">
                <span className="flex items-center gap-1.5 font-semibold">
                  Buying power
                  <Tooltip open={buyingPowerTipOpen} onOpenChange={setBuyingPowerTipOpen}>
                    <TooltipTrigger
                      aria-label="About buying power"
                      className="inline-flex text-muted-foreground outline-none"
                      onClick={() => setBuyingPowerTipOpen((open) => !open)}
                    >
                      <Info size={14} />
                    </TooltipTrigger>
                    <TooltipContent>
                      Cash free for your own trades: Robinhood buying power minus
                      what your takes are holding to buy their positions.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="text-right">
                  <span className="block font-medium tabular-nums">{money(free, currency)}</span>
                  {reservedShown && (
                    <span className="block text-xs text-muted-foreground tabular-nums">{money(reserved, currency)} held by takes</span>
                  )}
                </span>
              </div>
            );
          })()}
        </div>
      </section>


      <section aria-labelledby="investments-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="investments-heading" className="font-display text-[22px] tracking-[-0.02em]">Positions</h2>
          <p className="text-xs text-muted-foreground">
            {account.asOf ? `As of ${new Date(account.asOf).toLocaleString()}` : "Awaiting positions sync"}
          </p>
        </div>
        {view?.allocationWarnings?.map(w=><p key={w} role="alert" className="pb-2 text-xs text-destructive">{w}</p>)}
        {isCoinbase ? positionsReady ? <><CoinbasePositionRows accountId={view!.account!.id} key={view!.account!.id} positions={view?.selfDirectedSpotPositions??view?.spotPositions??[]} strategies={view?.strategies} historyByAllocation={historyByAllocation} range={range} series={strategySeriesBySymbol} loading={seriesPending}/></> : <p className="py-6 text-sm text-muted-foreground">Waiting for the first portfolio sync.</p> : !positionsReady && holdings.length === 0 && !view?.strategies?.length ? <p className="py-6 text-sm text-muted-foreground">Waiting for positions to sync.</p> : <PositionRows
          strategies={view?.strategies}
          historyByAllocation={historyByAllocation}
          strategySeriesBySymbol={strategySeriesBySymbol}
          holdings={holdings}
          seriesBySymbol={seriesBySymbol}
          range={range}
          currency={currency}
          loading={seriesPending}
        />}
        {(seriesError||shownSeries?.staleSymbols.length) ? <p role="status" className="py-2 text-xs text-muted-foreground">Price history unavailable{shownSeries?.staleSymbols.length ? ` for ${shownSeries.staleSymbols.join(', ')}` : ''}. Showing saved observations where available. Sync to retry.</p> : null}
        {!seriesPending&&!!shownSeries?.pendingSymbols.length&&<p className="py-2 text-xs text-muted-foreground">Price history is still loading. Sync to retry if it does not appear.</p>}
      <section aria-labelledby="activity-heading" className="pt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 id="activity-heading" className="font-display text-[22px] tracking-[-0.02em]">Activity</h2>
          {isCoinbase&&activity.length>5&&<button type="button" className="text-sm font-semibold underline underline-offset-4" onClick={()=>setAllCapitalActivity(value=>!value)}>{allCapitalActivity?'Show less':'View all'}</button>}
          {!isCoinbase&&view?.account?.selected && <Link to="/activity" className="text-sm font-semibold underline underline-offset-4 hover:text-foreground">
            View all
          </Link>}
        </div>
        {isCoinbase&&(view?.coinbaseHistory?.state!=='complete'||view.resources.some(r=>(r.resource==='spot_orders'||r.resource==='spot_fills')&&r.state!=='completed'))&&<p className="mb-2 text-xs text-muted-foreground">History is still syncing or incomplete. Showing the activity available so far.</p>}
        {activity.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">{isCoinbase?'No activity synced yet. Coinbase trades, transfers, and Take allocations will appear here.':'No activity yet. Fills on your connected accounts will show up here.'}</p>
        ) : <ActivityRows items={activity.slice(0,isCoinbase&&allCapitalActivity?100:5)} currency={currency} />}
      </section>
      </section>
      {(error || (!view?.account?.selected && !isCoinbase) || message || failed || stale) && <section aria-label="Portfolio data" className="space-y-3 border-t border-border pt-4">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!view?.account?.selected && !isCoinbase && <p className="text-xs text-muted-foreground">Select an account in <Link to="/settings" search={{section:'connections'}} className="underline">Connections</Link> to sync it.</p>}
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
        {failed ? <p className="text-xs text-destructive">Latest sync incomplete. {view?.portfolio ? 'Showing saved data; refresh to retry.' : 'Refresh to retry.'}</p> : stale && <p className="text-xs text-muted-foreground">Saved data may be stale.</p>}
      </section>}
    </SidePanelLayout>

      <Dialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <DialogContent showCloseButton={false}>
          <div className="space-y-2">
            <DialogTitle>Disconnect Robinhood?</DialogTitle>
            <DialogDescription>
              You&rsquo;ll need to reconnect to resume portfolio tracking and
              trading. Your holdings stay untouched in Robinhood.
            </DialogDescription>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={disconnecting} />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={() => void disconnect()} disabled={disconnecting}>
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}


function coinbaseValuationMessage(issue: string | null | undefined): string {
  const reasons: Record<string,string> = {
    unsettled: 'Some transactions are still pending or fall after the balance snapshot.',
    unsupported_event: 'History includes a transaction type we cannot yet reconcile.',
    ledger_mismatch: 'Transaction totals do not yet reconcile with the current holdings.',
    price_gap: 'Historical prices are unavailable for one or more holdings.',
    asset_limit: 'Historical pricing is incomplete for this number of holdings.',
    coverage: 'Complete spot history is not available for this portfolio.',
  };
  return `${reasons[issue ?? ''] ?? 'Transaction history could not be fully reconciled and priced.'} The chart uses saved balance snapshots.`;
}
