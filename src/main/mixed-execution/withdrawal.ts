import {randomUUID} from 'node:crypto';
import {mixedWithdrawalRequest,type MixedWithdrawal,type MixedWithdrawalLeg,type MixedWithdrawalRequest} from '../../shared/mixed-withdrawal';
import {decimalToScaledInteger as units,scaledIntegerToDecimal as decimal} from '../allocations/decimal';
import type {Database} from './contracts';
import {assertNoRuleRebalance as ruleRebalanceGate} from '../coinbase/order-reviews';
export interface WithdrawalAccount {venue:MixedWithdrawalLeg['venue'];accountId:string;accountLabel:string;holdingsUsd:string;valueUsd:string;currency:'USD'|'USDC';rate:string}
export interface MixedWithdrawalDependencies {
 enabled():boolean;clock?:()=>number;
 accounts(takeId:string,quote:'USD'|'USDC'):Promise<WithdrawalAccount[]>;
 band(takeId:string,account:WithdrawalAccount):Promise<{minimumAmount:string;maximumAmount:string;possible:boolean}>;
 preview(request:MixedWithdrawalRequest,account:WithdrawalAccount,amount:string):Promise<{leg:Omit<MixedWithdrawalLeg,'operationId'|'state'|'message'>;expiresAt:string}>;
 validate(view:MixedWithdrawal):Promise<void>;
 releaseReview(view:MixedWithdrawal,leg:MixedWithdrawalLeg):Promise<void>;
 drive(view:MixedWithdrawal,leg:MixedWithdrawalLeg):Promise<Pick<MixedWithdrawalLeg,'state'|'message'>>;
}
/** A withdrawal is one confirmed intent; child identities survive restarts. */
export function createMixedWithdrawals(database:Database,deps:MixedWithdrawalDependencies){
 const clock=deps.clock??Date.now;let work:Promise<unknown>|null=null,closing=false;
 const load=(id:string)=>database.use(async db=>(await db.query<{payload:MixedWithdrawal}>('SELECT payload FROM mixed_take_withdrawals WHERE id=$1',[id])).rows[0]?.payload??null);
 const save=(v:MixedWithdrawal)=>database.use(db=>db.query('UPDATE mixed_take_withdrawals SET state=$2,payload=$3,updated_at=$4 WHERE id=$1',[v.id,v.state,JSON.stringify(v),new Date(clock()).toISOString()]));
 // Matches the scheduler: never interleave with a working rule rebalance of this Take.
 const assertNoRuleRebalance=(takeId:string)=>database.use(db=>ruleRebalanceGate(db,takeId));
 async function exclusive<T>(fn:()=>Promise<T>){if(work||closing)throw Error('Another Take withdrawal operation is running. Try again shortly.');const next=fn();work=next;try{return await next;}finally{work=null;}}
 async function run(id:string){
  if(!deps.enabled())throw Error('Trading is unavailable. Reconnect before continuing.');
  const v=await load(id);if(!v)throw Error('Withdrawal review not found.');
  if(v.state==='completed'||v.state==='expired')return v;
  if(v.state==='preview'){
   if(Date.parse(v.expiresAt)<=clock()){v.state='expired';v.message='Review expired. Preview this withdrawal again.';await save(v);return v;}
   await assertNoRuleRebalance(v.takeId);
   await deps.validate(v);
   v.state='running';await save(v);
  }
  for(const leg of v.legs){
   if(leg.state==='completed')continue;
   try{Object.assign(leg,await deps.drive(v,leg));}
   catch(error){leg.state='attention';leg.message=error instanceof Error?error.message:'Could not continue this account. Check its orders before retrying.';}
   await save(v);
   // Do not start the other account after an uncertain/failed child operation.
   if(leg.state==='attention')break;
  }
  v.state=v.legs.every(l=>l.state==='completed')?'completed':v.legs.some(l=>l.state==='attention')?'attention':'running';
  v.message=v.state==='attention'?'One account needs attention. Completed sales will not be repeated.':null;
  await save(v);return v;
 }
 return {
  limits:async(takeId:string,quote:'USD'|'USDC')=>{
   const accounts=await deps.accounts(takeId,quote),total=accounts.reduce((n,a)=>n+Number(a.holdingsUsd),0);
   let min=0,max=total,possible=total>0;
   for(const a of accounts.filter(a=>Number(a.holdingsUsd)>0)){
    const b=await deps.band(takeId,a),share=Number(a.holdingsUsd)/total;
    min=Math.max(min,Number(b.minimumAmount)*Number(a.rate)/share);
    max=Math.min(max,Number(b.maximumAmount)*Number(a.rate)/share);possible&&=b.possible;
   }
   const minimum=Math.ceil(min*100)/100,maximum=Math.floor(max*100)/100;
   return {minimumAmount:String(minimum),maximumAmount:String(maximum),holdingsValue:String(total),possible:possible&&maximum>=minimum&&minimum>0};
  },
  preview:(raw:unknown)=>exclusive(async()=>{
   const request=mixedWithdrawalRequest.parse(raw);
   if(!deps.enabled())throw Error('Trading is unavailable.');
   const active=await database.use(async db=>(await db.query("SELECT 1 FROM mixed_take_withdrawals WHERE take_id=$1 AND state IN ('running','attention')",[request.takeId])).rows.length);
   if(active)throw Error('Finish the current Take withdrawal before starting another.');
   await assertNoRuleRebalance(request.takeId);
   const accounts=await deps.accounts(request.takeId,request.coinbaseCurrency);
   if(!accounts.length)throw Error('This Take has no investment to withdraw.');
   const total=accounts.reduce((n,a)=>n+units(a.holdingsUsd,36),0n);
   const requested=request.kind==='reduce'?units(request.amountUsd??'0',36):accounts.reduce((n,a)=>n+units(a.valueUsd,36),0n);
   if(request.kind==='reduce'&&(requested<=0n||requested>=total))throw Error('Enter an amount below the invested holdings value, or close the Take.');
   const v:MixedWithdrawal={id:randomUUID(),takeId:request.takeId,kind:request.kind,amountUsd:decimal(requested,36),state:'preview',expiresAt:new Date(clock()+60000).toISOString(),legs:[],message:null};
   const cent=10n**34n;let assigned=0n;
   const selling=accounts.filter(a=>request.kind==='close'||units(a.holdingsUsd,36)>0n);
   for(const [index,account] of selling.entries()){
    const dollars=request.kind==='close'?units(account.valueUsd,36):index===selling.length-1?requested-assigned:(requested*units(account.holdingsUsd,36)/total/cent)*cent;
    assigned+=dollars;
    const quantity=(dollars*10n**36n/units(account.rate,36)/cent)*cent;
    if(request.kind==='reduce'&&quantity<=0n)throw Error(`${account.venue==='coinbase'?'Coinbase':'Robinhood'}’s share is too small to sell. Increase the withdrawal or close the Take.`);
    const result=await deps.preview(request,account,decimal(quantity,36));
    v.legs.push({...result.leg,operationId:randomUUID(),state:'ready',message:null});
    if(Date.parse(result.expiresAt)<Date.parse(v.expiresAt))v.expiresAt=result.expiresAt;
   }
   await database.use(db=>db.query('INSERT INTO mixed_take_withdrawals(id,take_id,state,payload) VALUES($1,$2,$3,$4)',[v.id,v.takeId,v.state,JSON.stringify(v)]));return v;
  }),
  confirm:(id:string)=>exclusive(()=>run(id)),
  end:(id:string)=>exclusive(async()=>{
   const v=await load(id);if(!v)throw Error('Withdrawal not found.');
   if(v.state!=='attention')throw Error('Only a stopped withdrawal can be ended.');
   for(const leg of v.legs)await deps.releaseReview(v,leg);
   v.state='expired';v.message='Withdrawal ended. Completed sales remain recorded; preview the remaining investment to continue.';await save(v);return v;
  }),
  current:(takeId:string)=>database.use(async db=>(await db.query<{payload:MixedWithdrawal}>("SELECT payload FROM mixed_take_withdrawals WHERE take_id=$1 AND state<>'preview' ORDER BY created_at DESC LIMIT 1",[takeId])).rows[0]?.payload??null),
  async tick(){if(work||closing||!deps.enabled())return;await exclusive(async()=>{const ids=await database.use(async db=>(await db.query<{id:string}>("SELECT id FROM mixed_take_withdrawals WHERE state='running' ORDER BY created_at LIMIT 10")).rows);for(const {id} of ids)await run(id);});},
  busy:()=>work!==null,
  async close(){closing=true;await work;},
 };
}
