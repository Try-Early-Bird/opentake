import type { DatabaseClient as PGlite } from '../database-client';
import type {PortfolioView,PortfolioStrategy} from '../../shared/portfolio';
import {amount,format} from './ledger';
import type {ImportMapping} from './portfolio-import';
import {deriveAllocationValuation} from './allocation-valuation';
const factor=10n**18n;
/** Same physical snapshot for strategy claims and personal remainder. */
export async function addStrategyHoldings(db:Pick<PGlite,'query'>,view:PortfolioView){
 if(!view.account)return view;
 const accountId=view.account.id;
 const rows=(await db.query<{id:string;strategyId:string;takeId:string|null;status:string;restore:boolean;title:string;description:string;spec:PortfolioStrategy['spec']}>(`SELECT a.id,a.strategy_id AS "strategyId",t.id AS "takeId",a.status,a.restore_required AS restore,
 v.metadata->>'title' AS title,v.metadata->>'description' AS description,v.spec
 FROM strategy_allocations a JOIN strategy_versions v ON v.id=a.applied_version_id
 LEFT JOIN takes t ON t.strategy_id=a.strategy_id
 WHERE a.account_id=$1 AND a.status IN ('active','paused','diverged') ORDER BY a.created_at,a.id`,[accountId])).rows;
 const saved=(await db.query<{source_data:{exportedAt:string;allocations:{id:string}[]};mapping:ImportMapping}>(`SELECT source_data,mapping FROM strategy_portfolio_imports WHERE account_id=$1`,[accountId])).rows[0];
 const totalClaims=new Map<string,bigint>();let reservedCash=0n;
 const strategies:PortfolioStrategy[]=[];
 for(const a of rows){
  const ledger=(await db.query<{instrumentRef:string|null;symbol:string|null;quantity:string;cash:string}>(`SELECT instrument_ref AS "instrumentRef",max(symbol) AS symbol,coalesce(sum(quantity_delta),0)::text AS quantity,sum(cash_delta)::text AS cash FROM strategy_attribution_entries WHERE allocation_id=$1 GROUP BY instrument_ref`,[a.id])).rows;
  const cash=ledger.reduce((n,r)=>n+amount(r.cash),0n);reservedCash+=cash;
  const positions=ledger.filter(r=>r.instrumentRef!==null&&amount(r.quantity)!==0n).map(r=>({instrumentRef:r.instrumentRef!,symbol:r.symbol,quantity:format(amount(r.quantity))}));
  for(const p of positions)totalClaims.set(p.instrumentRef,(totalClaims.get(p.instrumentRef)??0n)+amount(p.quantity));
  const valuation=deriveAllocationValuation({cashUsd:format(cash),positions:positions.map(p=>({instrumentRef:p.instrumentRef,symbol:p.symbol??p.instrumentRef,quantity:p.quantity})),snapshot:view.positions.filter(p=>(p.assetClass==='equity'||p.assetClass==='crypto'))});
  const source=saved?.source_data.allocations.find(x=>saved.mapping.allocations[x.id]===a.id);
  strategies.push({allocationId:a.id,strategyId:a.strategyId,takeId:a.takeId,title:a.title??'Strategy',description:a.description??'',status:a.status,requiresReconciliation:a.restore,
   spec:a.spec,cash:format(cash),positions,value:valuation.ready?valuation.allocationValueUsd:null,importedAsOf:source?saved!.source_data.exportedAt:null});
 }
 const warnings:string[]=[];
 for(const [ref,q] of totalClaims){const p=view.positions.find(p=>(p.assetClass==='equity'||p.assetClass==='crypto')&&p.instrumentRef===ref);if(q<0n||!p||p.side==='short'||q>amount(p.quantity)){
  warnings.push(`Strategy ownership for ${p?.symbol??'an instrument'} needs reconciliation.`);
  for(const s of strategies)if(s.positions.some(p=>p.instrumentRef===ref)){s.requiresReconciliation=true;s.value=null;}
 }}
 const personal=view.positions.flatMap(p=>{
  const reserved=(p.assetClass==='equity'||p.assetClass==='crypto')?(totalClaims.get(p.instrumentRef)??0n):0n;
  if(reserved===0n)return [p];
  const held=amount(p.quantity),remaining=held-reserved;
  if(remaining<=0n)return [];
  const scaled=(value:string|null|undefined)=>value==null||held<=0n?null:format(amount(value)*remaining/held);
  return [{...p,quantity:format(remaining),marketValue:p.marketValue!==null?scaled(p.marketValue):p.markPrice===null?null:format(amount(p.markPrice)*remaining/factor),
   // Aggregate provider cost/P&L belongs to the physical position, not a subset.
   averageCost:null,providerUnrealizedPnl:null,providerRealizedPnl:null}];
 });
 const cash=view.portfolio?.cash==null?null:amount(view.portfolio.cash)-reservedCash;
 if(reservedCash<0n||cash!==null&&cash<0n)warnings.push('Strategy cash ownership needs reconciliation.');
 return {...view,strategies,selfDirectedPositions:personal,reservedCash:format(reservedCash),selfDirectedCash:cash===null||cash<0n?null:format(cash),allocationWarnings:warnings};
}
