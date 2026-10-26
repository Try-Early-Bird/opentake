import type { CapitalActivity, CoinbaseSpotPosition } from '../../shared/portfolio';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@electric-sql/pglite';
import type { createDatabaseLifecycle } from '../database';
import { decimalToScaledInteger as units, scaledIntegerToDecimal as decimal } from '../allocations/decimal';
import { createCoinbaseAllocations, readCoinbaseFundingRoom } from './allocations';
import { takeNameSql } from '../strategies/take-name';
import { coinbaseRiskRequest, type CoinbaseRiskPolicy, coinbaseCapitalRequest, type CoinbaseCapitalReview, type CoinbaseCapitalView } from '../../shared/coinbase-capital';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Input=Parameters<ReturnType<typeof createCoinbaseAllocations>['fund']>[0];
type Target={take_id:string;ready:boolean;account_id:string;account_label:string;strategy_id:string;version_id:string;take_title:string;allocation_id:string|null};
type Review={id:string;take_id:string;account_id:string;kind:'assign'|'release';input:Input;account_label:string;take_title:string;expires_at:Date;state:string};

/** Only the desktop bridge exposes these member-reviewed capital actions. */
export function createCoinbaseCapital(database:Database,clock=()=>Date.now(),refresh?:(accountId:string)=>Promise<unknown>,performance?:(strategyId:string)=>Promise<{gain:string;returnPercent:string|null;currency:string}|null>) {
 const core=createCoinbaseAllocations(database,clock);
 const targetQuery=`SELECT t.id AS take_id,r.account_id,coalesce(cd.label,a.nickname,a.masked_number) AS account_label,
   s.id AS strategy_id,v.id AS version_id,coalesce(nullif(v.metadata->>'title',''),t.title) AS take_title,ca.id AS allocation_id,
   (s.status='committed' AND s.archived_at IS NULL AND v.source_proposal_id=s.draft_revision_id) AS ready
   FROM takes t JOIN strategies s ON s.id=t.strategy_id JOIN local_owners owner ON owner.id=s.owner_id
   JOIN strategy_versions v ON v.id=s.current_version_id AND v.strategy_id=s.id
   JOIN strategy_account_routes r ON r.strategy_id=s.id AND r.venue='coinbase'
   JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id AND c.owner_id=s.owner_id AND c.venue='coinbase'
   LEFT JOIN coinbase_connection_details cd ON cd.connection_id=c.id
   LEFT JOIN coinbase_allocations ca ON ca.account_id=a.id AND ca.strategy_id=s.id
`;
 async function target(takeId:string):Promise<Target> {
  z.uuid().parse(takeId);
  const row=await database.use(async db=>(await db.query<Target>(`${targetQuery} WHERE t.id=$1`,[takeId])).rows[0]);
  if(!row)throw new Error('Commit this Take and save its Coinbase account before assigning funds.');
  return row;
 }
 async function risk(allocationId:string):Promise<CoinbaseRiskPolicy> {
  const policy=await database.use(async db=>(await db.query<CoinbaseRiskPolicy>('SELECT risk_currency AS currency,max_daily_notional::text AS "maxDailyNotional",max_loss::text AS "maxLoss" FROM coinbase_allocations WHERE id=$1',[allocationId])).rows[0]);
  return {...policy,maxDailyNotional:policy.maxDailyNotional===null?null:decimal(units(policy.maxDailyNotional,36),36),maxLoss:policy.maxLoss===null?null:decimal(units(policy.maxLoss,36),36)};
 }
 const accountReads={
  snapshot:core.snapshot,
  fundingRoom:(accountId:string)=>database.use(db=>readCoinbaseFundingRoom(db,accountId,clock)),
  observation:(accountId:string)=>database.use(async db=>(await db.query<{observed_at:Date;data:{portfolio:{currency:string};spotPositions:CoinbaseSpotPosition[];warnings?:string[]}}>('SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1',[accountId])).rows[0]),
 };
 async function view(takeId:string,withPerformance=false):Promise<CoinbaseCapitalView> {
  return presentView(await target(takeId),withPerformance,accountReads);
 }
 async function presentView(row:Target,withPerformance:boolean,reads:typeof accountReads):Promise<CoinbaseCapitalView> {
  const snapshot=await reads.snapshot(row.account_id);
  let buyingPower:{asset:string;amount:string}[]=[];
  try{buyingPower=(await reads.fundingRoom(row.account_id)).filter(r=>['USD','USDC'].includes(r.asset)&&r.state==='reconciled'&&r.unclaimed!==null).map(r=>({asset:r.asset,amount:r.unclaimed!}));}catch{/* Missing or unreconciled balances must not enable Max. */}
  const own=snapshot.claims.filter(c=>c.allocationId===row.allocation_id);
  const observed=await reads.observation(row.account_id);
  let total=0n,complete=!!observed&&clock()-observed.observed_at.getTime()<=900000&&clock()>=observed.observed_at.getTime()&&!observed.data.warnings?.length;
  const marks=new Map<string,{price:string;value:string}>();
  const fresh=complete;
  for(const claim of own){
   const q=units(claim.quantity,36);if(q===0n)continue;
   const position=observed?.data.spotPositions.find(p=>p.asset===claim.asset&&p.currency===observed.data.portfolio.currency);
   if(!position||units(position.quantity,36)<=0n||q>units(position.quantity,36)){complete=false;continue;}
   const value=q*units(position.marketValue,36)/units(position.quantity,36);
   if(fresh)marks.set(claim.asset,{price:decimal(units(position.marketValue,36)*10n**36n/units(position.quantity,36),36),value:decimal(value,36)});
   total+=value;
  }
  const valuation={currency:observed?.data.portfolio.currency??'USD',value:complete?decimal(total,36):null};
  const pnl=withPerformance&&complete&&row.allocation_id&&performance?await performance(row.strategy_id).catch(()=>null):null;
  return {valuation,pnl,buyingPower,risk:row.allocation_id?{allocationId:row.allocation_id,policy:await risk(row.allocation_id)}:undefined,accountId:row.account_id,accountLabel:row.account_label,takeTitle:row.take_title,
   balances:snapshot.claims.filter(c=>c.allocationId===row.allocation_id).map(c=>({asset:c.asset,quantity:decimal(units(c.quantity,36),36),reserved:decimal(units(c.reserved,36),36),...(marks.get(c.asset)??{})}))};
 }
 return {
  view,
  /** Read-only request cache: never shared with later reads or capital actions. */
  async viewMany(takeIds:string[],withPerformance=false):Promise<Record<string,CoinbaseCapitalView|null>> {
   const ids=z.array(z.uuid()).parse(takeIds);
   if(!ids.length)return {};
   const targets=await database.use(async db=>(await db.query<Target>(`${targetQuery} WHERE t.id=ANY($1::uuid[])`,[ids])).rows);
   function once<T>(read:(id:string)=>Promise<T>){
    const pending=new Map<string,Promise<T>>();
    return (id:string)=>{let result=pending.get(id);if(!result){result=read(id);pending.set(id,result);}return result;};
   }
   const reads={snapshot:once(accountReads.snapshot),fundingRoom:once(accountReads.fundingRoom),observation:once(accountReads.observation)};
   const result:Record<string,CoinbaseCapitalView|null>=Object.fromEntries(ids.map(id=>[id,null]));
   await Promise.all(targets.map(async row=>{result[row.take_id]=await presentView(row,withPerformance,reads).catch(()=>null);}));
   return result;
  },
  async saveRisk(raw:unknown):Promise<CoinbaseCapitalView> {
   const parsed=coinbaseRiskRequest.safeParse(raw);
   if(!parsed.success)throw new Error('Enter nonnegative limits with up to 36 decimal places and choose USD or USDC.');
   const input=parsed.data;
   await database.use(db=>db.transaction(async tx=>{
    // Serialize with allocation reservation/dispatch, and bind the edit to its original account.
    await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[input.accountId]);
    const valid=(await tx.query(`SELECT ca.id FROM coinbase_allocations ca
     JOIN strategies s ON s.id=ca.strategy_id JOIN takes t ON t.strategy_id=s.id
     JOIN strategy_account_routes r ON r.strategy_id=s.id AND r.venue='coinbase' AND r.account_id=ca.account_id
     JOIN linked_accounts a ON a.id=ca.account_id JOIN platform_connections c ON c.id=a.connection_id AND c.owner_id=s.owner_id AND c.venue='coinbase'
     JOIN local_owners owner ON owner.id=s.owner_id
     WHERE t.id=$1 AND ca.account_id=$2 AND ca.id=$3 AND NOT ca.restore_required
      AND ca.status='active' AND s.status='committed' AND s.archived_at IS NULL AND s.current_version_id=ca.version_id`,[input.takeId,input.accountId,input.allocationId])).rows.length;
    if(!valid)throw new Error('This allocation changed or is unavailable. Reopen its settings.');
    const policy=input.policy,expected=input.expected;
    const result=await tx.query(`UPDATE coinbase_allocations SET risk_currency=$4,max_daily_notional=$5,max_loss=$6
     WHERE id=$1 AND risk_currency IS NOT DISTINCT FROM $7::text
      AND max_daily_notional IS NOT DISTINCT FROM $8::numeric AND max_loss IS NOT DISTINCT FROM $9::numeric
      AND account_id=$2 AND strategy_id=(SELECT strategy_id FROM takes WHERE id=$3) RETURNING id`,
     [input.allocationId,input.accountId,input.takeId,policy.maxDailyNotional===null&&policy.maxLoss===null?null:policy.currency,policy.maxDailyNotional,policy.maxLoss,expected.currency,expected.maxDailyNotional,expected.maxLoss]);
    if(!result.rows.length)throw new Error('Limits changed since you opened them. Reopen settings to review the latest limits.');
   }));
   return view(input.takeId);
  },
  async activity(accountId:string):Promise<CapitalActivity[]> {
   z.uuid().parse(accountId);
   const rows=await database.use(async db=>(await db.query<{id:string;occurred_at:Date;kind:'assign'|'release';asset:string;quantity:string;take_id:string;take_title:string}>(`SELECT r.id,e.occurred_at,r.kind,e.asset,abs(e.quantity)::text AS quantity,r.take_id,coalesce(${takeNameSql('r.take_id')},r.take_title) AS take_title
    FROM coinbase_capital_reviews r JOIN coinbase_allocation_entries e ON e.account_id=r.account_id
     AND e.allocation_id=(r.input->>'allocationId')::uuid AND e.cause=(CASE WHEN r.kind='assign' THEN 'capital:' ELSE 'release:' END)||(r.input->>'cause')
    JOIN linked_accounts a ON a.id=r.account_id JOIN platform_connections c ON c.id=a.connection_id
    JOIN local_owners owner ON owner.id=c.owner_id
    WHERE r.account_id=$1 AND c.venue='coinbase' AND r.state='confirmed' AND e.kind IN ('capital','release')
    ORDER BY e.occurred_at DESC,r.id DESC LIMIT 100`,[accountId])).rows);
   const returned=await database.use(async db=>(await db.query<(typeof rows)[number]>(`SELECT e.id,e.occurred_at,'release' AS kind,e.asset,abs(e.quantity)::text AS quantity,i.take_id,coalesce(${takeNameSql('i.take_id')},t.title) AS take_title
    FROM coinbase_allocation_entries e JOIN coinbase_investments i ON e.cause LIKE 'investment-return:'||i.id::text||':%'
    JOIN takes t ON t.id=i.take_id JOIN linked_accounts a ON a.id=e.account_id JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners owner ON owner.id=c.owner_id
    WHERE e.account_id=$1 AND e.kind='release' AND e.quantity<0 ORDER BY e.occurred_at DESC LIMIT 100`,[accountId])).rows);
   const withdrawals=await database.use(async db=>(await db.query<(typeof rows)[number]>(`SELECT e.id,e.occurred_at,'release' AS kind,e.asset,abs(e.quantity)::text AS quantity,r.take_id,coalesce(${takeNameSql('r.take_id')},r.payload->>'takeTitle') AS take_title
    FROM coinbase_allocation_entries e JOIN coinbase_order_reviews r ON e.cause='withdrawal-return:'||r.id::text
    JOIN linked_accounts a ON a.id=e.account_id JOIN platform_connections c ON c.id=a.connection_id JOIN local_owners owner ON owner.id=c.owner_id
    WHERE e.account_id=$1 AND e.kind='release' AND e.quantity<0 ORDER BY e.occurred_at DESC LIMIT 100`,[accountId])).rows);
   rows.push(...withdrawals);
   rows.push(...returned);rows.sort((a,b)=>b.occurred_at.getTime()-a.occurred_at.getTime());
   return rows.slice(0,100).map(r=>({id:r.id,occurredAt:r.occurred_at.toISOString(),kind:r.kind,asset:r.asset,quantity:decimal(units(r.quantity,36),36),takeId:r.take_id,takeTitle:r.take_title}));
  },
  async preview(raw:unknown):Promise<CoinbaseCapitalReview> {
   const parsed=coinbaseCapitalRequest.safeParse(raw);
   if(!parsed.success)throw new Error('Choose USD or USDC and enter a positive amount with up to 36 decimal places.');
   const request=parsed.data,row=await target(request.takeId);
   if(request.kind==='assign'){
    const mixed=await database.use(async db=>(await db.query(`SELECT 1 FROM strategy_versions v,jsonb_array_elements(v.spec->'target'->'weights') w WHERE v.id=$1 AND w->'instrument'->>'venue'<>'coinbase' LIMIT 1`,[row.version_id])).rows.length>0);
    if(mixed)throw Error('Use the combined account review to fund a mixed Take.');
   }
   const quantity=decimal(units(request.quantity,36),36);
   if(request.kind==='assign'){
    if(!row.ready)throw new Error('Commit the latest Take changes before assigning funds.');
    await refresh?.(row.account_id);
    const room=await core.fundingRoom(row.account_id);
    if(room.some(c=>c.state!=='reconciled'))throw new Error('Sync and resolve account balance differences before assigning funds.');
    const currency=room.find(c=>c.asset===request.asset);
    if(!currency?.unclaimed||units(quantity,36)>units(currency.unclaimed,36))throw new Error(`Not enough unassigned ${request.asset} in this portfolio.`);
   }else{
    const own=(await view(request.takeId)).balances.find(c=>c.asset===request.asset);
    if(!own||units(quantity,36)>units(own.quantity,36)-units(own.reserved,36))throw new Error(`Not enough unreserved ${request.asset} assigned to this Take.`);
   }
   const id=randomUUID(),expiresAt=new Date(clock()+60000).toISOString();
   const input:Input={accountId:row.account_id,allocationId:row.allocation_id??randomUUID(),strategyId:row.strategy_id,versionId:row.version_id,asset:request.asset,quantity,cause:'member:'+id};
   await database.use(db=>db.query(`INSERT INTO coinbase_capital_reviews(id,take_id,account_id,kind,input,account_label,take_title,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,request.takeId,row.account_id,request.kind,JSON.stringify(input),row.account_label,row.take_title,new Date(clock()).toISOString(),expiresAt]));
   return {...request,quantity,id,accountLabel:row.account_label,takeTitle:row.take_title,expiresAt};
  },
  async confirm(id:string):Promise<CoinbaseCapitalView> {
   z.uuid().parse(id);
   const review=await database.use(async db=>(await db.query<Review>('SELECT * FROM coinbase_capital_reviews WHERE id=$1',[id])).rows[0]);
   if(!review)throw new Error('Review unavailable.');
   const authorize=async(tx:Transaction)=>{
    // Recheck and consume the immutable review in the same transaction as capital.
    if(review.kind==='assign'&&!(await tx.query(`SELECT 1 FROM strategies s JOIN strategy_versions v ON v.id=s.current_version_id
     WHERE s.id=$1 AND v.id=$2 AND v.source_proposal_id=s.draft_revision_id AND s.archived_at IS NULL`,[review.input.strategyId,review.input.versionId])).rows.length)throw new Error('Commit the latest Take changes and review the amount again.');
    const result=await tx.query(`UPDATE coinbase_capital_reviews SET state='confirmed' WHERE id=$1 AND state='pending' AND expires_at>$2 RETURNING id`,[id,new Date(clock()).toISOString()]);
    if(!result.rows.length)throw new Error('This review expired. Review the amount again.');
   };
   if(review.kind==='assign')await core.fund(review.input,authorize);
   else {
    const {strategyId:_strategyId,versionId:_versionId,...input}=review.input;
    await core.release(input,authorize);
   }
   return view(review.take_id);
  },
 };
}
