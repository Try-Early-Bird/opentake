import type {PerformanceBasis,PerformanceRange,StrategyPerformance} from '../../shared/strategy-performance';
import type {CoinbaseCapitalView} from '../../shared/coinbase-capital';

// What the AI in a strategy's take may read about the member's money in it:
// the opentake_read_strategy_investment tool. Read-only by construction: it
// summarizes the same holdings, instructions and performance the strategy page
// shows, and offers no way to invest, trade or move money (the AI
// never places orders).

export interface InvestmentSummaryDeps {
 holdings():Promise<{holdings:unknown[]}>;
 instructions(allocationId:string):Promise<{instructions:unknown[]}>;
 performance(strategyId:string,range:PerformanceRange,basis:PerformanceBasis):Promise<StrategyPerformance|null>;
 /** The Take's Coinbase allocation, or null when it has none. */
 coinbase?():Promise<CoinbaseCapitalView|null>;
}
const cashAssets=['USD','USDC'];
/** A Coinbase allocation as the AI reads it: what the Take holds there and each asset's share. */
function coinbaseInvestment(view:CoinbaseCapitalView){
 const held=view.balances.filter(b=>Number(b.quantity)>0);
 if(!held.length)return null;
 // USD and USDC count at face value; other assets at their latest marked value.
 const valueOf=(b:typeof held[number])=>cashAssets.includes(b.asset)?Number(b.quantity):b.value===undefined||b.value===null?null:Number(b.value);
 const values=held.map(valueOf),complete=values.every(v=>v!==null),total=complete?values.reduce((a,v)=>a+v!,0):null;
 return {venue:'coinbase',account:view.accountLabel,status:'active',value:view.valuation?.value??null,currency:view.valuation?.currency??'USD',
  cash:held.filter(b=>cashAssets.includes(b.asset)).map(b=>({asset:b.asset,quantity:b.quantity,reserved:b.reserved})),
  positions:held.filter(b=>!cashAssets.includes(b.asset)).map(b=>({symbol:b.asset,quantity:b.quantity,value:b.value??null,price:b.price??null})),
  // Current share of each asset (cash included), for comparing with the target weights.
  weights:total?Object.fromEntries(held.map((b,i)=>[b.asset,(values[i]!/total*100).toFixed(2)+'%'])):null,
  pnl:view.pnl??null};
}

interface Holding {
 bucket:{id:string;status:string};strategy:{id:string;displayName:string};
 valuation:{currency:string;cash:string;totalValue:string|null};
 positions:{symbol:string;quantity:string;value?:string|null}[];
 pnl?:{capitalAllocated:string;unrealized:string|null;realized:string;allTimeReturn:string|null};
 openExecutions?:number;waiting?:{reason:string;until:string|null}|null;lastFailure?:{symbol:string|null;code:string;at:string|null}|null;
 ordersOpenAt?:string|null;requiresReconciliation?:boolean;closure?:{status:string}|null;
}

const returnOf=(performance:StrategyPerformance|null)=>{
 const stat=performance?.stats[0];
 return stat===undefined?null:{allTimeReturnPercent:stat.allTimeReturnPercent,from:stat.startedAt,asOf:stat.asOf,source:stat.source};
};

export async function summarizeInvestment(deps:InvestmentSummaryDeps,strategyId:string){
 const holdings=((await deps.holdings()).holdings as Holding[]).filter(h=>h.strategy.id===strategyId);
 const [model,actual]=await Promise.all([
  deps.performance(strategyId,'1y','model').catch(()=>null),
  deps.performance(strategyId,'all','actual').catch(()=>null),
 ]);
 const investments:Record<string,unknown>[]=[];
 const coinbase=await deps.coinbase?.().catch(()=>null);
 const onCoinbase=coinbase?coinbaseInvestment(coinbase):null;
 if(onCoinbase)investments.push(onCoinbase);
 for(const h of holdings){
  const instructions=(await deps.instructions(h.bucket.id).catch(()=>({instructions:[]}))).instructions;
  investments.push({
   venue:'robinhood',
   status:h.requiresReconciliation?'paused_for_review':h.bucket.status,
   value:h.valuation.totalValue,cash:h.valuation.cash,currency:h.valuation.currency,
   positions:h.positions.map(p=>({symbol:p.symbol,quantity:p.quantity,value:p.value??null})),
   pnl:h.pnl??null,
   openOrders:h.openExecutions??0,
   waiting:h.waiting??null,ordersOpenAt:h.ordersOpenAt??null,lastFailure:h.lastFailure??null,
   closure:h.closure?.status??null,
   pendingInstructions:instructions,
  });
 }
 return {
  strategyId,
  invested:investments.length>0,
  investments,
  performance:{simulatedPastYear:returnOf(model),actualSinceInvested:actual?.actualAvailable?returnOf(actual):null},
  note:'Read-only. Investing, deposits, withdrawals and closing happen on the take page. The member commits a new version from the take panel beside the chat. A Robinhood investment then rebalances at the next market session; a Coinbase investment keeps its version until the member switches it on the take page, and switching places no orders (it rebalances only on its schedule, drift band or a rule).',
 };
}
