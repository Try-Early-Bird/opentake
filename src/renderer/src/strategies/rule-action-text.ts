import {money} from '../portfolio/format';
import type {StrategyRule} from '../../../shared/strategy-rules';

const usd=(value:number|string)=>money(value).replace(/\.00$/,'');
export const actionName=(kind:string)=>({rebalance_to_target:'Rebalance to target',deploy_cash:'Invest the Take’s cash',reduce:'Reduce (money back to your account)',request_review:'Ask you to review',pause_self:'Pause itself'} as Record<string,string>)[kind]??kind.charAt(0).toUpperCase()+kind.slice(1);
/** A trading action with its amount, so a changed amount shows in reviews (not just the kind). */
export const amountText=(m:Extract<StrategyRule['action'],{amount?:unknown}>['amount'])=>!m?null:'currency' in m?`${usd(m.value)}${m.currency==='USD'?'':` ${m.currency}`}`:'kind' in m&&m.kind==='scope_bps'?`${Number(m.value)/100}%`:`${m.value} units`;
export const actionText=(a:StrategyRule['action'])=>{const amount='amount' in a?amountText(a.amount):null;
 return amount===null?actionName(a.kind):a.kind==='reduce'?`Reduce by ${amount} (money back to your account)`:a.kind==='deploy_cash'?`Invest up to ${amount} of the Take’s cash`:`${actionName(a.kind)} · ${amount}`;};
