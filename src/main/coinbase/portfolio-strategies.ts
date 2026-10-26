import type {PortfolioStrategy,CoinbaseSpotPosition} from '../../shared/portfolio';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
export interface CoinbasePortfolioAllocation {id:string;strategyId:string;takeId:string|null;title:string;description:string;status:string;restore:boolean;spec:PortfolioStrategy['spec']}
export interface CoinbasePortfolioClaim {allocationId:string;asset:string;quantity:string}
/** Attribute the same physical snapshot to Takes and the personal remainder. */
export function coinbasePortfolioStrategies(allocations:CoinbasePortfolioAllocation[],claims:CoinbasePortfolioClaim[],positions:CoinbaseSpotPosition[]){
 const warnings:string[]=[];
 const unsafe=new Set<string>();
 for(const claim of claims){
  if(Number(claim.quantity)===0)continue;
  const position=positions.find(p=>p.asset===claim.asset);
  if(claim.quantity.startsWith('-')||!position||position.takeAllocations===undefined)unsafe.add(claim.asset);
 }
 for(const asset of unsafe)warnings.push(`Take ownership for ${asset} needs reconciliation.`);
 const strategies:PortfolioStrategy[]=allocations.flatMap(a=>{
  const owned=claims.filter(c=>c.allocationId===a.id&&Number(c.quantity)!==0);
  if(!owned.length)return [];
  let cash=0n,value=0n;let valid=!a.restore&&!owned.some(c=>unsafe.has(c.asset));
  const held:PortfolioStrategy['positions']=[];
  for(const claim of owned){
   const p=positions.find(p=>p.asset===claim.asset);
   if(!p||claim.quantity.startsWith('-')){valid=false;continue;}
   const quantity=units(p.quantity,36);
   if(quantity===0n){valid=false;continue;}
   const attributed=units(p.marketValue,36)*units(claim.quantity,36)/quantity;
   value+=attributed;
   if(p.isCash)cash+=attributed;
   else held.push({instrumentRef:p.instrumentRef,symbol:p.asset,quantity:claim.quantity});
  }
  return [{allocationId:a.id,strategyId:a.strategyId,takeId:a.takeId,title:a.title,description:a.description,status:a.status,requiresReconciliation:!valid,spec:a.spec,cash:decimal(cash,36),value:valid?decimal(value,36):null,positions:held,importedAsOf:null}];
 });
 const personal=positions.flatMap(p=>{
  // Keep the physical holding visible when ownership is uncertain.
  if(unsafe.has(p.asset)||!p.takeAllocations)return [p];
  const total=units(p.quantity,36),assigned=p.takeAllocations.reduce((n,c)=>n+units(c.quantity,36),0n);
  if(assigned===0n)return [p];
  if(assigned>total){warnings.push(`Take ownership for ${p.asset} needs reconciliation.`);return [p];}
  const remaining=total-assigned;if(remaining===0n)return [];
  return [{...p,quantity:decimal(remaining,36),marketValue:decimal(units(p.marketValue,36)*remaining/total,36),availableValue:null,averageEntryPrice:null,unrealizedPnl:null,takeAllocations:[]}];
 });
 return {strategies,selfDirectedSpotPositions:personal,warnings};
}
