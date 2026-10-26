import {createHash} from 'node:crypto';
import {z} from 'zod';
import {basketSchema,type BasketSpec} from '../../shared/strategies';
import type {MixedPreview,MixedVenue} from '../../shared/mixed-execution';
import type {Database,Query,Context,InvestmentDependencies} from './contracts';
import {investmentVenueAdapters} from './adapters';
import {createMixedPreview} from './preview';
import {createMixedPreviewStore} from './store';
import {createMixedExecution} from './coordinator';
import {createMixedExecutionStore} from './execution-store';
import {decimalToScaledInteger as units} from '../allocations/decimal';
import {assertNoRuleRebalance} from '../coinbase/order-reviews';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createMixedInvestments(database:Database,deps:InvestmentDependencies){
 const clock=deps.clock??Date.now;
 const adapters=investmentVenueAdapters(database,deps);
 let work:Promise<unknown>|null=null,closing=false;
 const exclusive=<T>(action:()=>Promise<T>):Promise<T>=>{
  if(closing)return Promise.reject(Error('The app is shutting down.'));
  // A user review waits behind the current background pass. Rejecting a
  // healthy in-flight provider call would turn normal latency into an error.
  const previous=work;
  const result=(async()=>{await previous?.catch(()=>{});if(closing)throw Error('The app is shutting down.');return action();})().finally(()=>{if(work===result)work=null;});
  work=result;return result;
 };
 async function context(db:Query,takeId:string,withBalances=true):Promise<Context>{
  const row=(await db.query<{strategy_id:string;version_id:string;revision:string;spec:BasketSpec}>(`SELECT s.id AS strategy_id,v.id AS version_id,p.revision,v.spec
   FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners o ON o.id=s.owner_id
   JOIN strategy_versions v ON v.id=s.current_version_id AND v.source_proposal_id=s.draft_revision_id
   JOIN strategy_account_plans p ON p.strategy_id=s.id
   WHERE t.id=$1 AND s.status='committed' AND s.archived_at IS NULL`,[takeId])).rows[0];
  if(!row)throw Error('Review and commit this Take, then choose an account on each platform.');
  const spec=basketSchema.parse(row.spec);
  const venues=[...new Set(spec.target.weights.map(w=>w.instrument.venue))];
  if(venues.length<2||venues.some(v=>!Object.hasOwn(adapters,v)))throw Error('Choose at least two supported trading platforms.');
  const routes=(await db.query<{venue:MixedVenue;accountId:string}>(`SELECT r.venue,r.account_id AS "accountId" FROM strategy_account_routes r
   JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners o ON o.id=c.owner_id
   WHERE r.strategy_id=$1 AND c.venue=r.venue AND a.available AND c.status='connected'
   ORDER BY r.venue`,[row.strategy_id])).rows;
  if(routes.length!==venues.length||routes.some(r=>!venues.includes(r.venue)))throw Error('Choose a connected trading account on both platforms. The Robinhood account must be selected in Portfolio.');
  const blocked=(await db.query<{blocked_symbols:string[]}>('SELECT p.blocked_symbols FROM trading_preferences p JOIN local_owners o ON o.id=p.owner_id LIMIT 1')).rows[0]?.blocked_symbols??[];
  const available={} as Context['available'],allocations:Context['allocations']={},claims:unknown[]=[];
  for(const route of routes){const state=await adapters[route.venue].readAccount(db,row.strategy_id,route.accountId,withBalances);available[route.venue]=state.available;allocations[route.venue]=state.allocation;claims.push([route.venue,state.claims]);}
  const claimsHash=hash([allocations,claims]);
  return {allocations,claimsHash,takeId,strategyId:row.strategy_id,versionId:row.version_id,routeRevision:row.revision,spec,routes,available,blocked,evidence:hash([row.version_id,row.revision,routes,available,blocked,claimsHash])};
 }
 async function assertReady(db:Query,c:Context){
  if((await db.query("SELECT 1 FROM mixed_take_withdrawals WHERE take_id=$1 AND state IN ('running','attention')",[c.takeId])).rows.length)throw Error('Finish this Take’s withdrawal before depositing again.');
  if((await db.query("SELECT 1 FROM mixed_take_executions WHERE take_id=$1 AND state<>'completed' LIMIT 1",[c.takeId])).rows.length)throw Error('Wait for the current investment to finish before depositing again.');
  await assertNoRuleRebalance(db,c.takeId);
  for(const [venue,a] of Object.entries(c.allocations)){
   if(!a)continue;
   if(a.account_id!==c.routes.find(r=>r.venue===venue)?.accountId||a.version_id!==c.versionId)throw Error('Review the latest Take version on both accounts before depositing.');
   if(a.status!=='active'||a.restore_required)throw Error('Resume and reconcile both accounts before depositing.');
  }
  for(const route of c.routes)await adapters[route.venue].assertIdle(db,c.strategyId);
 }
 async function validate(db:Query,preview:MixedPreview){
  if(!deps.enabled())throw Error('Trading is disabled.');
  const c=await context(db,preview.takeId);
  if(c.versionId!==preview.versionId||c.routeRevision!==preview.routeRevision)throw Error('Take or account choices changed. Preview again.');
  await assertReady(db,c);
  for(const leg of preview.legs){
   if(c.routes.find(r=>r.venue===leg.venue)?.accountId!==leg.accountId)throw Error('Funding account changed.');
   if(units(c.available[leg.venue][leg.currency]??'0',36)<units(leg.quantity,36))throw Error(`${leg.venue==='coinbase'?'Coinbase':'Robinhood'} has insufficient buying power. Preview again.`);
   if(leg.evidence!==c.evidence)throw Error('Balances or holdings changed. Preview again.');
   if(leg.orders.some(o=>c.blocked.includes(o.symbol)))throw Error('A holding is blocked in trading preferences.');
  }
 }
 const store=createMixedExecutionStore(database,{
  validate,
  reserve:async(tx,p,leg)=>adapters[leg.venue].reserve(tx,p,leg,await context(tx,p.takeId,false)),
 },clock);
 const coordinator=createMixedExecution({store,clock,preview:async id=>{
  const row=await database.use(async db=>(await db.query<{payload:MixedPreview}>('SELECT payload FROM mixed_take_previews WHERE id=$1',[id])).rows[0]);if(!row)throw Error('Investment preview unavailable.');return row.payload;
 },validate:async p=>{
  const c=await database.use(db=>context(db,p.takeId,false));
  for(const route of c.routes)await deps.refresh(route.venue,route.accountId);
  await database.use(db=>validate(db,p));
 },adapters});
 async function prepare(raw:unknown){
  const input=z.object({takeId:z.uuid(),operationId:z.uuid(),amountUsd:z.string(),coinbaseCurrency:z.enum(['USD','USDC'])}).strict().parse(raw);
  if(!deps.enabled())throw Error('Trading is disabled.');
  const routing=await database.use(db=>context(db,input.takeId,false));
  await database.use(db=>assertReady(db,routing));
  for(const route of routing.routes)await deps.refresh(route.venue,route.accountId);
  const rate=input.coinbaseCurrency==='USDC'?await deps.usdcRate(routing.routes.find(r=>r.venue==='coinbase')!.accountId):undefined;
  const rateAt=clock();
  const previews=createMixedPreview({store:createMixedPreviewStore(database),executionEnabled:true,clock,
   load:async takeId=>({...await database.use(db=>context(db,takeId)),usdcUsdRate:rate,rateObservedAt:rateAt}),
   preview:async(leg,base)=>{
    const c=base as Context,available=c.available[leg.venue][leg.currency]??'0';
    const common={venue:leg.venue,accountId:leg.accountId,currency:leg.currency,quantity:leg.quantity,available,evidence:c.evidence,expiresAt:new Date(clock()+60000).toISOString()};
    if(units(available,36)<units(leg.quantity,36))return {...common,state:'blocked',reason:`Not enough ${leg.currency} in this account.`,orders:[],retainedCash:leg.quantity};
    return adapters[leg.venue].preview(leg,c,common);
   },
  });
  return previews({...input,versionId:routing.versionId,routeRevision:routing.routeRevision});
 }
 return {
  preview:(raw:unknown)=>exclusive(()=>prepare(raw)),
  invest:(raw:unknown)=>exclusive(()=>{if(!deps.enabled())throw Error('Trading is disabled.');return coordinator.start(raw);}),
  current:async(takeId:string)=>{z.uuid().parse(takeId);const row=await database.use(async db=>(await db.query<{id:string}>('SELECT id FROM mixed_take_executions WHERE take_id=$1 ORDER BY created_at DESC LIMIT 1',[takeId])).rows[0]);return row?store.find(row.id):null;},
  async tick(){if(work||closing||!deps.enabled())return;await exclusive(async()=>{const rows=await database.use(async db=>(await db.query<{id:string;preview_id:string}>("SELECT id,preview_id FROM mixed_take_executions WHERE state IN ('funded','running','attention') ORDER BY created_at LIMIT 20")).rows);for(const row of rows)await coordinator.start({operationId:row.id,previewId:row.preview_id});});},
  busy:()=>work!==null,
  async close(){closing=true;await work;await coordinator.close();},
 };
}
