import { useCoinbaseLivePrice } from '../data-sources/useCoinbaseLivePrice';
import { assetActivity } from '../portfolio/local-adapter';
import {Select} from '../components/ui/select';
import {cryptoPrice,cryptoVolume} from '../crypto-price';
import {useRouter,useParams,useSearch} from '@tanstack/react-router';
import {ArrowLeft} from 'lucide-react';
import {useEffect,useState} from 'react';
import type {CoinbaseMarketSnapshot,CoinbaseMarketSeries} from '../../../shared/coinbase-markets';
import type {PortfolioView} from '../../../shared/portfolio';
import type {PriceRange} from '../../../shared/market-series';
import {MarketChart,type MarketHoverPoint} from '../components/MarketChart';
import {SidePanelLayout} from '../components/SidePanelLayout';
import {HoldingLogo} from '../components/HoldingLogo';
import {Button} from '../components/ui/button';
import {RollingNumber} from '../components/RollingNumber';
import {cryptoLogo} from '../crypto-logos';
import {MarketHoldersPanel} from '../strategies/MarketHoldersPanel';
import {cn} from '../lib/utils';
import {AddToListMenu} from '../components/AddToListMenu';
const ranges=['1d','1w','1m','3m','1y'] as const;
const periods={ '1d':'Past 24h','1w':'Past week','1m':'Past month','3m':'Past 3 months','1y':'Past year',all:'All time'};
export function CoinbaseMarketDetail():React.JSX.Element {
 const router=useRouter();
 const {product}=useParams({from:'/coinbase/$product'});const search=useSearch({from:'/coinbase/$product'});
 const livePrice=useCoinbaseLivePrice(product);
 const [range,setRange]=useState<PriceRange>('1d');const [detail,setDetail]=useState<CoinbaseMarketSnapshot|null>(null);const [chart,setChart]=useState<CoinbaseMarketSeries|null>(null);const [pending,setPending]=useState(true);const [error,setError]=useState(false);const [hover,setHover]=useState<MarketHoverPoint|null>(null);const [generation,setGeneration]=useState(0);
 const [accountsReady,setAccountsReady]=useState(false);
 const [accounts,setAccounts]=useState<PortfolioView['accounts']>([]);const [accountId,setAccountId]=useState(search.accountId??'');const [view,setView]=useState<PortfolioView|null>(null);const [accountPending,setAccountPending]=useState(false);const [accountError,setAccountError]=useState(false);
 useEffect(()=>{if(!accountsReady)return;let cancelled=false;setDetail(null);setError(false);void window.dataSources.coinbaseMarket(product,accountId||undefined).then(d=>{if(!cancelled)setDetail(d);}).catch(()=>{if(!cancelled)setError(true);});return()=>{cancelled=true;};},[product,accountId,accountsReady,generation]);
 useEffect(()=>{
  let cancelled=false,busy=false;setChart(null);setHover(null);setPending(true);
  const refresh=async()=>{if(cancelled||busy||document.hidden)return;busy=true;
   try{const data=await window.dataSources.coinbaseSeries(product,range);if(!cancelled)setChart(data);}
   catch{/* Keep the last chart while the candle endpoint recovers. */}
   finally{busy=false;if(!cancelled)setPending(false);}
  };
  void refresh();const timer=setInterval(()=>void refresh(),60000);const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('focus',focus);};
 },[product,range,generation]);
 useEffect(()=>{const focus=()=>setGeneration(v=>v+1);window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[]);
 useEffect(()=>{let cancelled=false;void window.portfolio.snapshot().then(data=>{if(!cancelled){const next=data.accounts.filter(a=>a.venue==='coinbase');setAccounts(next);setAccountId(current=>next.some(a=>a.id===current)?current:next[0]?.id??'');setAccountsReady(true);}}).catch(()=>{if(!cancelled)setAccountError(true);});return()=>{cancelled=true;};},[generation]);
 useEffect(()=>{let cancelled=false;setView(null);setAccountError(false);if(!accountId){setAccountPending(false);return;}setAccountPending(true);void window.portfolio.snapshot(accountId).then(data=>{if(!cancelled){if(data.account?.id!==accountId||data.account.venue!=='coinbase')throw Error('Account unavailable');setView(data);}}).catch(()=>{if(!cancelled)setAccountError(true);}).finally(()=>{if(!cancelled)setAccountPending(false);});return()=>{cancelled=true;};},[accountId,generation]);
 const market=detail?.market,series=chart?.series??undefined;const quote=market?.quote??product.split('-')[1]??'USD';const base=market?.base??product.split('-')[0];
 const holding=view?.spotPositions?.find(p=>p.asset===base);const synced=view?.resources.some(r=>r.resource==='portfolio'&&r.observedAt);const value=hover?.value??livePrice??market?.price??series?.price;
 const baseline=Number(series?.baseline?.price);
 const dayBaseline=Number(market?.price)/(1+Number(market?.change24h)/100);
 const liveBaseline=range==='1d'&&market?.change24h!=null?dayBaseline:baseline;
 const liveChange=livePrice!==null&&Number.isFinite(liveBaseline)&&liveBaseline>0?String((Number(livePrice)-liveBaseline)/liveBaseline*100):null;
 const change=hover&&baseline>0?String((hover.value-baseline)/baseline*100):liveChange??(range==='1d'?market?.change24h??series?.change?.percent:series?.change?.percent);
 const positive=Number(change??0)>=0;
 const dayPercent=market?.change24h==null?NaN:Number(market.change24h),currentPrice=market?.price==null?NaN:Number(market.price);
 const dayMove=holding?.currency===quote&&Number.isFinite(dayPercent)&&dayPercent>-100&&Number.isFinite(currentPrice)?{change:{amount:String(currentPrice-currentPrice/(1+dayPercent/100)),percent:String(dayPercent)},extendedChange:null}:undefined;
 return <div className="space-y-8">
  <button type="button" onClick={()=>router.history.canGoBack()?router.history.back():void router.navigate({to:"/portfolio"})} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={14}/> Back</button>
  <SidePanelLayout sticky className="space-y-8" aside={<MarketHoldersPanel
   activity={assetActivity(view,base)} symbol={base} venue="coinbase" currency={holding?.currency??quote} strategies={[]} showAttribution={holding?.takeAllocations!==undefined} attributedPositions={holding?.takeAllocations}
   holding={holding?{marketRef:holding.instrumentRef,symbol:base,assetClass:'crypto',side:'long',size:holding.quantity,positionValue:holding.marketValue,averageEntryPrice:holding.averageEntryPrice??null,unrealizedPnl:holding.unrealizedPnl??null,realizedPnl:null}:undefined}
   series={dayMove}
   accountControl={accounts.length>1?<Select id="coinbase-holdings-account" ariaLabel="Holdings account" className="mt-3 mb-2 w-full" value={accountId} onValueChange={setAccountId} items={accounts.map(a=>({value:a.id,label:a.label}))}/>:undefined}
   positionMessage={accountPending?'Loading holdings…':accountError?'Holdings unavailable.':!accountId?'No Coinbase account connected.':!synced?'Waiting for portfolio sync.':undefined}
  />}>
   <section aria-labelledby="market-heading">
    <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
    <div>
    <div className="flex items-center gap-3"><HoldingLogo weight={{symbol:base,logoUrl:cryptoLogo(base)}}/><h1 id="market-heading" className="font-display text-[26px] tracking-[-0.02em]">{market?.name??base}</h1><AddToListMenu target={{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:product,kind:'crypto'},symbol:product,...(market?.name?{name:market.name}:{})}}}/></div>
    <p className="mt-2 text-xs text-muted-foreground">{product} · Coinbase · Spot{livePrice!==null&&!hover?' · Live price':''}</p>
    <p className="font-display mt-1 text-[32px] tracking-[-0.03em]"><RollingNumber value={value==null?'—':cryptoPrice(value,quote)}/></p>
    {change!=null&&<p className={cn('mt-1 text-[13px] font-medium',positive?'text-success':'text-error')}><RollingNumber value={`${positive?'▲':'▼'} ${Math.abs(Number(change)).toFixed(2)}%${hover?'':` ${periods[range]}`}`}/></p>}
    </div>
    <dl aria-label="24-hour market statistics" className="flex flex-wrap gap-x-6 gap-y-3">
     <div><dt className="text-[11px] font-medium text-muted-foreground">Volume (24H)</dt><dd className="mt-0.5 text-[13px] tabular-nums" title={market?.quoteVolume24h==null?undefined:cryptoPrice(market.quoteVolume24h,quote)}>{market?.quoteVolume24h==null?'—':cryptoVolume(market.quoteVolume24h,quote)}</dd></div>
     <div><dt className="text-[11px] font-medium text-muted-foreground">High (24H)</dt><dd className="mt-0.5 text-[13px] tabular-nums">{market?.high24h==null?'—':cryptoPrice(market.high24h,quote)}</dd></div>
     <div><dt className="text-[11px] font-medium text-muted-foreground">Low (24H)</dt><dd className="mt-0.5 text-[13px] tabular-nums">{market?.low24h==null?'—':cryptoPrice(market.low24h,quote)}</dd></div>
    </dl>
    </div>
    {(error||detail?.stale)&&<p role="status" className="mt-2 text-xs text-muted-foreground">{detail?'Showing cached market data.':'Market details unavailable.'} <Button variant="ghost" size="sm" onClick={()=>setGeneration(v=>v+1)}>Retry</Button></p>}
    <div className="mt-6 h-[clamp(14rem,40vh,28rem)]">{series&&series.points.length>1?<MarketChart series={series} range={range} positive={Number(series.change?.amount??0)>=0} onHoverPoint={setHover}/>:<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{pending?'Loading price history…':'No price history available for this range.'}</div>}</div>
    <div className="flex gap-1 border-b border-border py-2">{ranges.map(r=><Button key={r} variant="ghost" size="sm" className={cn('h-8 rounded-none border-b-2 text-sm uppercase hover:bg-transparent',r===range?'border-brand font-semibold text-brand':'border-transparent text-muted-foreground')} onClick={()=>setRange(r)}>{r}</Button>)}</div>
    {chart?.stale&&<p className="mt-2 text-xs text-muted-foreground">Price history may be incomplete or out of date.</p>}
   </section>
   {market?.description&&<section aria-label="About asset"><h2 className="text-sm font-medium">About {market.name}</h2><p className="mt-2 whitespace-pre-line text-[13px] text-muted-foreground">{market.description}</p></section>}
   {market?.marketCap&&<p className="text-sm">Market cap: {market.marketCap}</p>}
  </SidePanelLayout>
 </div>;
}
