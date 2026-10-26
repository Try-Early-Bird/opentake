import {z} from 'zod';
import {instrumentKey,type StrategyInstrument} from '../../shared/strategies';
import {evaluateEligibility} from './eligibility';
import type {createConnections} from '../connections';
import {normalizeTradability} from '../strategies/tradability';
import {createEligibilityRefresh,type EligibilityRefresh} from './eligibility-refresh';

type Connections=Pick<ReturnType<typeof createConnections>,'status'|'readTool'>;
/** Read-only provider adapter; missing facts retain the normalizer's unknown state. */
export function createRobinhoodEligibility(connections:Connections,refresh:EligibilityRefresh=createEligibilityRefresh()){
 return async(accountId:string,symbols:string[],signal:AbortSignal,instruments:readonly StrategyInstrument[]=[])=>{
  const scope=async()=>{
   const status=await connections.status();
   const account=status.accounts.find(a=>a.id===accountId&&a.selected&&a.agenticAllowed);
   if(status.status!=='connected'||!account)throw Error('Eligibility account unavailable');
   return {accountType:account.accountType,authority:JSON.stringify([status.checkedAt,account])};
  };
  const initial=await scope();signal.throwIfAborted();
  const crypto=instruments.filter(i=>i.market&&symbols.includes(i.symbol));
  const equity=symbols.filter(symbol=>!crypto.some(i=>i.symbol===symbol)||instruments.some(i=>!i.market&&i.symbol===symbol));
  const unique=[...new Set(equity)].sort();
  const facts:ReturnType<typeof normalizeTradability>=[];
  for(let i=0;i<unique.length;i+=10){
   const batch=unique.slice(i,i+10);
   const evidence=await refresh.refresh({venue:'robinhood',environment:'production',accountId,authority:initial.authority},JSON.stringify(['equity-tradability',batch]),async sharedSignal=>{
    const raw=await connections.readTool('get_equity_tradability',{symbols:batch},accountId,AbortSignal.any([sharedSignal,AbortSignal.timeout(15_000)]));
    if((await scope()).authority!==initial.authority)throw Error('Eligibility account changed');
    return normalizeTradability(raw,batch,initial.accountType);
   },signal);
   facts.push(...evidence.value);
  }
  for(const instrument of new Map(crypto.map(i=>[instrumentKey(i),i])).values()){
   const market=instrument.market!;
   if(instrument.venue!=='robinhood'||market.venue!=='robinhood'||market.instance!=='production'||market.kind!=='crypto')throw Error('Unsupported eligibility instrument');
   const evidence=await refresh.refresh({venue:'robinhood',environment:'production',accountId,authority:initial.authority},JSON.stringify(['crypto-eligibility',instrumentKey(instrument),'buy']),async sharedSignal=>{
    const raw=await connections.readTool('get_crypto_eligibility',{currency_pair_id:market.reference,side:'buy'},accountId,AbortSignal.any([sharedSignal,AbortSignal.timeout(15_000)]));
    if((await scope()).authority!==initial.authority)throw Error('Eligibility account changed');
    const result=z.object({pairId:z.literal(market.reference),symbol:z.literal(instrument.symbol),side:z.literal('buy'),checks:z.array(z.object({check:z.string(),satisfied:z.boolean().nullable()})).min(4)}).parse(raw);
    const required=['Account active','Pair available for trading','Selected account type permits this side','No applicable trading halt'];
    if(required.some(label=>result.checks.filter(c=>c.check===label).length!==1))throw Error('Incomplete crypto eligibility');
    const decision=evaluateEligibility(result.checks.map(c=>({code:'product_restricted' as const,symbols:[instrument.symbol],satisfied:c.satisfied})));
    return {symbol:instrumentKey(instrument),tradable:decision.ok?true:decision.state==='blocked'?false:null,fractional:true,detail:null,name:null};
   },signal);
   facts.push(evidence.value);
  }
  if((await scope()).authority!==initial.authority)throw Error('Eligibility account changed');
  signal.throwIfAborted();
  return [...equity.map(symbol=>facts.find(f=>f.symbol===symbol)??normalizeTradability({},[symbol],initial.accountType)[0]),...facts.filter(f=>crypto.some(i=>instrumentKey(i)===f.symbol))];
 };
}
