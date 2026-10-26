import type { createConnections } from '../connections';
import type { BasketSpec, Verification } from '../../shared/strategies';
import { createRobinhoodEligibility } from '../trading/robinhood-eligibility';
import {instrumentEligibility} from '../trading/eligibility';
export function createBasketVerification(connections:Pick<ReturnType<typeof createConnections>,'status'|'readTool'>,clock=()=>Date.now(),readEligibility=createRobinhoodEligibility(connections)){
 return async(spec:BasketSpec):Promise<Verification>=>{
  const result:Verification={policy:'personal_basket',version:1,checkedAt:new Date(clock()).toISOString(),accountRef:null,results:spec.target.weights.map(w=>({instrument:w.instrument,state:'unknown',tradable:null,fractional:null,reason:w.instrument.market?'Robinhood crypto trading support is not ready; account eligibility has not been verified.':w.instrument.venue==='robinhood'?'Connect an eligible Robinhood account to verify.':w.instrument.venue==='coinbase'?'Coinbase eligibility and sizing are checked for the selected account and quote currency during order preview.':'This venue has no verification adapter yet.'}))};
  try{
   const status=await connections.status(),account=status.accounts.find(a=>a.selected&&a.agenticAllowed);
   if(status.status!=='connected'||!account)return result;result.accountRef=account.id;
   const rows=result.results.filter(r=>r.instrument.venue==='robinhood'&&!r.instrument.market);
   for(let i=0;i<rows.length;i+=10){
    const batch=rows.slice(i,i+10);
    try{
     const facts=await readEligibility(account.id,batch.map(r=>r.instrument.symbol),AbortSignal.timeout(20_000));
     batch.forEach((r,j)=>{const f=facts[j];r.tradable=f.tradable;r.fractional=f.fractional;
      const decision=instrumentEligibility(f,true);
      // Whole-share-only execution remains unsupported in the Take editor;
      // preserve its existing "unknown" presentation while execution blocks it.
      r.state=f.tradable===false?'blocked':decision.ok?'pass':'unknown';
      r.reason=f.tradable===false?'Not tradable on this account.':f.tradable===true&&f.fractional===false?'Whole-share only; execution sizing is not available yet.':r.state==='pass'?'Eligibility and fractional sizing verified.':'Provider did not supply complete eligibility facts.';
     });
    }catch{batch.forEach(r=>{r.reason='Verification is unavailable; try again later.';});}
   }
  }catch{/* An unavailable connection is unknown, never a passing check. */}
  return result;
 };
}
