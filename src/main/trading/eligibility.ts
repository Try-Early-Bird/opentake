import type {EligibilityCode,EligibilityResult} from '../../shared/trading';
export interface EligibilityCheck {code:EligibilityCode;symbols:string[];satisfied:boolean|null}
export interface EligibilityDecision extends EligibilityResult {state:'eligible'|'blocked'|'unknown'}
/** Adapters supply facts, callers supply applicable requirements. Only explicit
 * true satisfies a requirement. A known denial remains blocked even when other
 * evidence is missing; unknown evidence can never authorize execution. */
export function evaluateEligibility(checks:readonly EligibilityCheck[]):EligibilityDecision{
 const reasons:EligibilityResult['reasons']=[];let blocked=false;
 if(!checks.length)return {ok:false,state:'unknown',reasons:[{code:'eligibility_unknown',symbols:[]}]};
 for(const check of checks){
  if(check.satisfied===true)continue;
  if(check.satisfied===false)blocked=true;
  const code=check.satisfied===false?check.code:'eligibility_unknown';
  const existing=reasons.find(reason=>reason.code===code);
  if(existing)existing.symbols=[...new Set([...existing.symbols,...check.symbols])].sort();
  else reasons.push({code,symbols:[...new Set(check.symbols)].sort()});
 }
 return {ok:reasons.length===0,state:blocked?'blocked':reasons.length?'unknown':'eligible',reasons};
}

/** Common instrument requirements; fractional sizing is an explicit caller
 * requirement, not an assumption applied to every crypto or equity order. */
export function instrumentEligibility(facts:{symbol:string;tradable:boolean|null;fractional:boolean|null},requireFractional:boolean):EligibilityDecision{
 return evaluateEligibility([
  {code:'symbol_not_tradable',symbols:[facts.symbol],satisfied:facts.tradable},
  ...(requireFractional?[{code:'symbol_not_fractional' as const,symbols:[facts.symbol],satisfied:facts.fractional}]:[]),
 ]);
}
export class TradingEligibilityError extends Error {
 constructor(public readonly result:EligibilityResult,message:string){super(message);this.name='TradingEligibilityError';}
}
export function eligibility(code:EligibilityCode,symbols:string[]=[]):EligibilityResult{return {ok:false,reasons:[{code,symbols}]};}
export const eligible=():EligibilityResult=>({ok:true,reasons:[]});
export function assertEligible(result:EligibilityResult,message:string){if(!result.ok)throw new TradingEligibilityError(result,message);}
export function reviewEligibility(enabled:boolean,expiresAt:number,now:number):EligibilityResult{
 if(!enabled)return eligibility('trading_disabled');
 if(!Number.isFinite(expiresAt)||expiresAt<=now)return eligibility('review_expired');
 return eligible();
}
/** First investment must acquire every target. Later rebalances may skip dust. */
export function basketEligibility(firstPurchase:boolean,targets:readonly string[],plannedBuys:readonly string[]):EligibilityResult{
 if(!firstPurchase)return eligible();
 const planned=new Set(plannedBuys),missing=targets.filter(symbol=>!planned.has(symbol));
 return missing.length?eligibility('incomplete_basket',missing):eligible();
}
export function blockedAssetEligibility(symbols:readonly string[],blocked:readonly string[]):EligibilityResult{
 const denied=new Set(blocked.map(s=>s.toUpperCase()));
 const found=symbols.filter(s=>denied.has(s.toUpperCase()));
 return found.length?eligibility('symbol_blocked',found):eligible();
}
