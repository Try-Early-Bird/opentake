import {decimalToScaledInteger} from '../allocations/decimal';
import type {EligibilityResult} from '../../shared/trading';
/** All amounts in an invocation must use the same explicit valuation currency. */
export interface RiskInput {
 currency:string;precision?:number;maxDailyNotional?:string|null;placedToday?:string;planned?:string;
 maxLoss?:string|null;capital?:string;value?:string;
}
export function riskEligibility(input:RiskInput):EligibilityResult{
 if(!input.currency)throw new Error('Risk currency required');
 const units=(v:string)=>v.startsWith('-')?-decimalToScaledInteger(v.slice(1),input.precision??18):decimalToScaledInteger(v,input.precision??18),reasons:EligibilityResult['reasons']=[];
 if(input.maxDailyNotional!=null){
  if(input.placedToday===undefined||input.planned===undefined)throw new Error('Daily notional evidence required');
  if(units(input.placedToday)+units(input.planned)>units(input.maxDailyNotional))reasons.push({code:'daily_notional_limit',symbols:[]});
 }
 if(input.maxLoss!=null){
  if(input.capital===undefined||input.value===undefined)throw new Error('Loss valuation evidence required');
  if(units(input.capital)-units(input.value)>units(input.maxLoss))reasons.push({code:'loss_limit_reached',symbols:[]});
 }
 return {ok:reasons.length===0,reasons};
}
