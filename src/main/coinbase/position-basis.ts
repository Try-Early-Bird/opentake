import {format} from './order-planner';
import {decimalToScaledInteger} from '../allocations/decimal';
const amount=(value:string)=>value.startsWith('-')?-decimalToScaledInteger(value.slice(1),36):decimalToScaledInteger(value,36);
export interface BasisEntry {asset:string;quantity:string;kind:string;cause:string}
/** Average cost from this allocation's fills, including quote fees. Never borrow account-wide cost basis. */
export function positionBasis(entries:BasisEntry[],symbol:string,quote:string):{quantity:string;cost:string|null}{
 const groups=new Map<string,BasisEntry[]>();
 for(const entry of entries){const group=groups.get(entry.cause)??[];group.push(entry);groups.set(entry.cause,group);}
 let quantity=0n,cost:bigint|null=0n;
 for(const group of groups.values()){
  const entry=group.find(e=>e.asset===symbol);if(!entry)continue;
  const delta=amount(entry.quantity);
  if(delta>0n){
   const paid=group.find(e=>e.asset===quote);
   cost=cost!==null&&entry.kind==='fill'&&paid&&amount(paid.quantity)<0n?cost-amount(paid.quantity):null;
  }else if(delta<0n){
   if(quantity<=0n||-delta>quantity)cost=null;
   else if(cost!==null)cost=cost*(quantity+delta)/quantity;
  }
  quantity+=delta;if(quantity===0n)cost=0n;
 }
 return {quantity:format(quantity),cost:cost===null?null:format(cost)};
}
