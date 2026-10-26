import type {AllocationHistory,AllocationHistoryRange,PortfolioStrategy} from '../../../shared/portfolio';
import type {PortfolioRange} from '../portfolio-history';
import type {StrategyPerformance} from '../../../shared/strategy-performance';
import type {SeriesChange,SeriesPoint,SymbolSeries} from '../market-series';

// A strategy row draws 1D from
// its legs' intraday series and longer ranges from the allocation's daily
// history (ledger × daily closes), as the hosted rows do.

/** Which history backs a portfolio range; 1D stays intraday and composed. */
export function historyRangeFor(range:PortfolioRange):AllocationHistoryRange|null{
 switch(range){
  case '1d':return null;
  case '1w':
  case '1m':return '1m';
  case '3m':return '3m';
  case '1y':return '1y';
  case 'all':return 'all';
 }
}

/**
 * Coinbase Takes have no attribution ledger; their actual performance line is a
 * flow-free unit index. Scaled so its last point is the row's current value,
 * it reads as dollars with the same percent change.
 */
export function historyFromPerformance(allocationId:string,range:AllocationHistoryRange,performance:StrategyPerformance|null,value:string|null):AllocationHistory|null{
 if(!performance||value===null)return null;
 const last=Number(performance.points.at(-1)?.unitValue),current=Number(value);
 if(performance.unavailableReason||performance.basis!=='actual'||!performance.actualAvailable||!(last>0)||!Number.isFinite(current))return null;
 return {allocationId,range,points:performance.points.map(point=>({day:point.day,totalValue:(Number(point.unitValue)*current/last).toFixed(2)}))};
}

/**
 * Turns stored daily allocation values into the row's series shape for a range.
 * The point before the window is the baseline so the change reads like the
 * stock rows; 1W trims the 1M history to the last seven days.
 */
export function seriesFromAllocationHistory(history:AllocationHistory,range:PortfolioRange,symbol:string,nowMs=Date.now()):SymbolSeries|undefined{
 if(history.points.length===0)return undefined;
 const windowDays=range==='1w'?7:null;
 const cutoff=windowDays===null?null:new Date(nowMs-windowDays*86_400_000).toISOString().slice(0,10);
 const inWindow=history.points.filter(point=>cutoff===null||point.day>=cutoff);
 if(inWindow.length===0)return undefined;
 const before=cutoff===null?null:[...history.points].reverse().find(point=>point.day<cutoff)??null;
 const baselinePoint=before??inWindow[0]!;
 const last=inWindow[inWindow.length-1]!;
 const points:SeriesPoint[]=inWindow.map(point=>({t:`${point.day}T21:00:00.000Z`,c:point.totalValue,s:'regular'}));
 const baseline=Number(baselinePoint.totalValue);
 const price=Number(last.totalValue);
 const change:SeriesChange|null=Number.isFinite(baseline)&&baseline!==0&&Number.isFinite(price)
  ?{amount:(price-baseline).toFixed(2),percent:(((price-baseline)/baseline)*100).toFixed(2)}
  :null;
 return {symbol,interval:'day',bounds:'regular',baseline:{price:baselinePoint.totalValue,kind:before===null?'first_bar':'window_open'},
  price:last.totalValue,extendedPrice:null,extendedSession:null,change,extendedChange:null,points};
}

// Composes an allocation's value series from the per-symbol series the
// portfolio already fetches: attributed shares × each symbol's closes, plus
// the allocation's cash. Timestamps are unioned across symbols and each
// symbol carries its last known close forward, so the sparkline, baseline,
// and change describe the same window as the stock rows around it.

function toFixed(value:number,digits=2):string{return value.toFixed(digits);}

function change(baseline:number|null,price:number|null):SeriesChange|null{
 if(baseline===null||price===null||baseline===0)return null;
 const amount=price-baseline;
 return {amount:toFixed(amount),percent:toFixed((amount/baseline)*100)};
}

export function composeStrategySeries(holding:PortfolioStrategy,seriesBySymbol:ReadonlyMap<string,SymbolSeries>):SymbolSeries|undefined{
 const legs=holding.positions
  .map(position=>({quantity:Number(position.quantity),series:position.symbol===null?undefined:seriesBySymbol.get(position.symbol.toUpperCase())}))
  .filter(leg=>Number.isFinite(leg.quantity)&&leg.quantity>0);
 if(legs.length===0)return undefined;
 if(legs.some(leg=>leg.series===undefined||leg.series.points.length===0))return undefined;
 const series=legs.map(leg=>({quantity:leg.quantity,series:leg.series!}));
 const cash=Number(holding.cash);
 const cashValue=Number.isFinite(cash)?cash:0;
 const template=series[0]!.series;

 // Union of timestamps, each symbol carried forward from its last close and
 // seeded with its baseline before its first bar.
 const timestamps=[...new Set(series.flatMap(leg=>leg.series.points.map(point=>point.t)))]
  .sort((left,right)=>Date.parse(left)-Date.parse(right));
 const cursors=series.map(leg=>({...leg,index:0,
  last:leg.series.baseline===null?Number(leg.series.points[0]!.c):Number(leg.series.baseline.price)}));
 const points:SeriesPoint[]=timestamps.map(t=>{
  const at=Date.parse(t);
  let total=cashValue;
  let session:SeriesPoint['s']='regular';
  for(const cursor of cursors){
   while(cursor.index<cursor.series.points.length&&Date.parse(cursor.series.points[cursor.index]!.t)<=at){
    const point=cursor.series.points[cursor.index]!;
    cursor.last=Number(point.c);
    session=point.s;
    cursor.index+=1;
   }
   total+=cursor.quantity*cursor.last;
  }
  return {t,c:toFixed(total,4),s:session};
 });

 const sum=(pick:(leg:SymbolSeries)=>string|null):number|null=>{
  let total=cashValue;
  for(const leg of series){
   const value=pick(leg.series);
   if(value===null)return null;
   total+=leg.quantity*Number(value);
  }
  return total;
 };
 const baseline=sum(leg=>leg.baseline?.price??null);
 const price=sum(leg=>leg.price);
 const anyExtended=series.some(leg=>leg.series.extendedPrice!==null);
 const extendedPrice=anyExtended?sum(leg=>leg.extendedPrice??leg.price):null;

 return {
  symbol:holding.title.toUpperCase(),
  interval:template.interval,
  bounds:template.bounds,
  ...(template.sessionDate===undefined?{}:{sessionDate:template.sessionDate}),
  ...(template.dayStart===undefined?{}:{dayStart:template.dayStart}),
  ...(template.dayEnd===undefined?{}:{dayEnd:template.dayEnd}),
  baseline:baseline===null||template.baseline===null?null:{price:toFixed(baseline,4),kind:template.baseline.kind},
  price:price===null?null:toFixed(price,4),
  extendedPrice:extendedPrice===null?null:toFixed(extendedPrice,4),
  extendedSession:anyExtended?(series.find(leg=>leg.series.extendedSession!==null)?.series.extendedSession??null):null,
  change:change(baseline,price),
  // Like the per-symbol series, the extended move is measured from the
  // regular-session close rather than the previous close.
  extendedChange:anyExtended?change(price,extendedPrice):null,
  points,
 };
}

/** The largest weights plus cash, for a one-line "major allocation" summary. */
export function majorAllocations(spec:PortfolioStrategy['spec'],limit=4):Array<{label:string;percent:number}>{
 const weights=spec.target.weights.map(w=>({symbol:w.instrument.symbol,weightPercent:w.bps/100}));
 const cashPercent=spec.target.cashBps/100;
 const top=[...weights].sort((left,right)=>right.weightPercent-left.weightPercent).slice(0,limit)
  .map(weight=>({label:weight.symbol,percent:weight.weightPercent}));
 const shown=top.reduce((sum,item)=>sum+item.percent,0);
 // Weights are basis points; round so float error never reads as a sliver of "others".
 const other=Math.round((100-cashPercent-shown)*100)/100;
 if(other>0)top.push({label:`${weights.length-top.length} others`,percent:other});
 if(cashPercent>0)top.push({label:'Cash',percent:cashPercent});
 return top;
}

/** Highest value first, like the hosted holdings list. */
export function sortedStrategyHoldings(holdings:readonly PortfolioStrategy[]):PortfolioStrategy[]{
 return [...holdings].sort((left,right)=>Number(right.value??0)-Number(left.value??0));
}
