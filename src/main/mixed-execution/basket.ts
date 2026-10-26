import {investmentVenues} from '../../shared/investment-venues';
import {basketSchema,assertInstrumentExecution,type BasketSpec} from '../../shared/strategies';
import type {MixedVenue} from '../../shared/mixed-execution';
import type {Transaction} from '@electric-sql/pglite';
export function venueBasket(input:BasketSpec,venue:MixedVenue):BasketSpec{
 const spec=basketSchema.parse(input),weights=spec.target.weights.filter(w=>w.instrument.venue===venue).sort((a,b)=>a.instrument.symbol.localeCompare(b.instrument.symbol));
 if(!weights.length)throw Error(`No ${venue} holdings in this Take.`);
 if(spec.target.weights.some(w=>!Object.hasOwn(investmentVenues,w.instrument.venue)))throw Error('Unsupported investment platform.');
 const sum=weights.reduce((n,w)=>n+w.bps,0),total=10000-spec.target.cashBps;
 const parts=weights.map((w,i)=>({i,value:Math.floor(w.bps*total/sum),remainder:w.bps*total%sum}));
 let left=total-parts.reduce((n,p)=>n+p.value,0);
 for(const part of [...parts].sort((a,b)=>b.remainder-a.remainder||a.i-b.i)){if(!left)break;part.value++;left--;}
 if(parts.some(p=>!p.value))throw Error('A venue allocation is too small.');
 return basketSchema.parse({...spec,target:{cashBps:spec.target.cashBps,weights:weights.map((w,i)=>({...w,bps:parts[i].value}))}});
}
/** Pure-venue callers cannot use a mixed version without a funded coordinator journal. */
export async function executionBasket(db:Pick<Transaction,'query'>,spec:BasketSpec,identity:{strategyId:string;versionId:string;accountId:string},venue:MixedVenue){
 assertInstrumentExecution(spec);
 if(spec.target.weights.every(w=>w.instrument.venue===venue))return spec;
 const bound=(await db.query(`SELECT 1 FROM mixed_take_executions e JOIN takes t ON t.id=e.take_id JOIN mixed_take_previews p ON p.id=e.preview_id
 WHERE t.strategy_id=$1 AND (p.version_id=$2 OR EXISTS(SELECT 1 FROM coinbase_allocation_decisions d JOIN coinbase_allocations a ON a.id=d.allocation_id WHERE a.strategy_id=t.strategy_id AND d.kind='adopt' AND d.details->>'toVersion'=$2::text)) AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'legs') l WHERE l->>'venue'=$3 AND l->>'accountId'=$4) LIMIT 1`,[identity.strategyId,identity.versionId,venue,identity.accountId])).rows.length;
 if(!bound)throw Error('Funding mixed-platform Takes requires the combined account review.');
 return venueBasket(spec,venue);
}
