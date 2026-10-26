// A rule's buy / trim / exit is a
// change to the Take's target, proposed as a suggestion; after the member applies and
// commits it, the Take's own rebalancing moves it there. Pure: no database or broker.
import type {z} from 'zod';
import type {basketSchema} from '../../shared/strategies';
import type {StrategyRule} from '../../shared/strategy-rules';

type Spec=z.infer<typeof basketSchema>;
type Market={venue:string;reference:string;pair?:string};
export type TargetChange={ok:true;spec:Spec;summary:string}|{ok:false;reason:'market_unknown'|'amount_unsupported'|'value_unavailable'|'not_enough_cash'|'already_there'|'all_cash'};

const pct=(bps:number)=>`${bps%100?(bps/100).toFixed(2).replace(/0$/,''):bps/100}%`;
/** The ticker a market names, where the venue's reference carries it (Coinbase "BTC-USD"). */
function symbolOf(m:Market){return m.venue==='coinbase'?m.reference.split('-')[0].toUpperCase():null;}
function find(spec:Spec,m:Market){
 return spec.target.weights.findIndex(w=>w.instrument.venue===m.venue&&(w.instrument.market?.reference===m.reference||(!!symbolOf(m)&&w.instrument.symbol===symbolOf(m))));
}

/** The Take's new target for a buy / trim / exit, from its committed spec. `value` is the
 *  Take's current value, needed only for a dollar buy. */
export function targetChange(spec:Spec,action:StrategyRule['action'],value?:number|null):TargetChange{
 const next:Spec=structuredClone(spec),weights=next.target.weights;
 if(action.kind==='exit'){
  // A Take holds at least one asset; all cash is a withdrawal or close, not a target.
  if(!action.market)return {ok:false,reason:'all_cash'};
  const i=find(next,action.market);if(i<0)return {ok:false,reason:'already_there'};
  if(weights.length===1)return {ok:false,reason:'all_cash'};
  const [w]=weights.splice(i,1);next.target.cashBps+=w.bps;
  return {ok:true,spec:next,summary:`${w.instrument.symbol} ${pct(w.bps)} → 0% (to cash)`};
 }
 if(action.kind==='trim'){
  const i=find(next,action.market);if(i<0)return {ok:false,reason:'market_unknown'};
  const w=weights[i],to=action.toWeightBps;if(w.bps<=to)return {ok:false,reason:'already_there'};
  if(to===0&&weights.length===1)return {ok:false,reason:'all_cash'};
  next.target.cashBps+=w.bps-to;const was=w.bps;
  if(to===0)weights.splice(i,1);else w.bps=to;
  return {ok:true,spec:next,summary:`${w.instrument.symbol} ${pct(was)} → ${pct(to)} (to cash)`};
 }
 if(action.kind==='buy'){
  let add:number;
  if(action.amount.kind==='scope_bps')add=action.amount.value;
  else if(action.amount.kind==='notional'){if(!value||value<=0)return {ok:false,reason:'value_unavailable'};add=Math.floor(Number(action.amount.value)/value*10000);}
  else return {ok:false,reason:'amount_unsupported'};
  if(add<1)return {ok:false,reason:'already_there'};
  if(add>next.target.cashBps)return {ok:false,reason:'not_enough_cash'};
  let i=find(next,action.market);
  if(i<0){const symbol=symbolOf(action.market);if(!symbol)return {ok:false,reason:'market_unknown'};
   if(weights.length>=50)return {ok:false,reason:'amount_unsupported'};
   weights.push({instrument:{venue:action.market.venue,symbol},bps:0});i=weights.length-1;}
  const w=weights[i],was=w.bps;w.bps+=add;next.target.cashBps-=add;
  return {ok:true,spec:next,summary:`${w.instrument.symbol} ${pct(was)} → ${pct(w.bps)} (from cash)`};
 }
 return {ok:false,reason:'amount_unsupported'};
}

/** What moves the Take to its target by itself: its calendar, its drift band and its
 *  rebalance rules that are on. Empty means a target change waits for a manual rebalance. */
export function rebalanceKeepers(spec:Spec,rules:{name:string;action:StrategyRule['action'];on:boolean}[]){
 const keepers:string[]=[];
 if(spec.rebalance.schedule!=='never')keepers.push(`the ${spec.rebalance.schedule} rebalance`);
 if(spec.rebalance.driftBandPoints!==null||spec.rebalance.driftBandRelative!==null)keepers.push('the drift band');
 for(const r of rules)if(r.on&&(r.action.kind==='rebalance_to_target'||r.action.kind==='agent'&&r.action.capabilities.actions.includes('rebalance_to_target')))keepers.push(`rule “${r.name}”`);
 return keepers;
}

/** The note shown with a rule's target suggestion. */
export function keepersNote(keepers:string[]){
 return keepers.length?`Once committed, ${keepers.join(', ')} will keep the Take at the new target.`:'This Take does not rebalance by itself; after committing, rebalance it to reach the new target.';
}
