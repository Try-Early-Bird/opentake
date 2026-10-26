import {robinhoodCryptoOrders} from '../trading/robinhood-crypto-orders';
import type {CryptoPriceSample} from '../assets/crypto-price-history';
import {robinhoodCryptoPortfolio} from '../trading/robinhood-crypto-portfolio';
import {z} from 'zod';
import {amount,format} from '../allocations/ledger';
import {bindRobinhoodCryptoAccount,resolveRobinhoodCryptoAccount} from '../robinhood-account-binding';
import {cryptoReadPages,robinhoodCryptoPreview} from '../trading/robinhood-crypto-preview';
import {cryptoPreviewInput} from './crypto-preview-contract';
import type {PreparedCryptoSubmission} from './crypto-execution';
import type {CryptoIntentRow} from './crypto-journal';
import type {PlacementResponse} from './contract';
import type {CryptoSubmissionScope} from './robinhood-crypto-adapter';

type Read=(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
type Write=(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<PlacementResponse>;
/** Main-process only. The session and its prepared send must remain inside the
 * connection queue callback. No raw account identifiers cross IPC. */
export function createCryptoTransport(read:Read,write:Write,externalRef:string,accountId:string,signal:AbortSignal){
 async function binding(){signal.throwIfAborted();const accounts=await read('get_accounts',{},signal);return {accounts,account:bindRobinhoodCryptoAccount(accounts,externalRef)};}
 async function review(raw:unknown){
  const parsed=cryptoPreviewInput.safeParse(raw);
  if(!parsed.success)throw Error('Enter a positive USD amount and limit price using decimal numbers');
  const order=parsed.data;
  // Takes buy in USD and sell owned units. Never derive a sell from dollars.
  if(order.side==='buy'?!order.dollar_amount:!order.quantity)throw Error('Crypto execution requires USD buys or unit sells');
  const {accounts,account}=await binding();
  const preview=await robinhoodCryptoPreview(read,accounts,externalRef,order,signal,true);
  if(!preview.eligibility.ok||!preview.preview)throw Error('Crypto order is not eligible; refresh its account and pair checks');
  const maximumDebit=order.side==='buy'?cryptoBuyMaximumDebit(order.dollar_amount!,order.type):'0';
  if(preview.preview.estimatedTotal===null||(order.side==='buy'&&amount(preview.preview.estimatedTotal)>amount(maximumDebit)))throw Error('Preview does not fit the provider debit cap');
  return {order,preview,maximumDebit,account};
 }
 async function scope(intent:CryptoIntentRow):Promise<CryptoSubmissionScope>{
  if(intent.account_id!==accountId)throw Error('Crypto account changed');
  const {account}=await binding();
  const symbol=z.object({symbol:z.string().min(1)}).parse(intent.review_result).symbol;
  return {accountId,accountNumber:account.accountNumber,cryptoAccountNumber:account.cryptoAccountNumber,clientRef:intent.ref_id,symbol,order:intent.order_request};
 }
 return {
  async orders(since:string,knownOpen:readonly string[]){
   signal.throwIfAborted();
   const account=resolveRobinhoodCryptoAccount(await read('get_accounts',{},signal),externalRef);
   if(!account){if(knownOpen.length)throw Error('Crypto account missing while orders remain open');return [];}
   return robinhoodCryptoOrders(read,account,since,knownOpen,signal);
  },
  async portfolio(targets:readonly string[],onQuotes?:(samples:CryptoPriceSample[])=>Promise<void>){
   signal.throwIfAborted();
   const account=resolveRobinhoodCryptoAccount(await read('get_accounts',{},signal),externalRef);
   signal.throwIfAborted();
   return account?robinhoodCryptoPortfolio(read,account.rhsAccountNumber,targets,signal,undefined,onQuotes):[];
  },
  async review(raw:unknown){const result=await review(raw);return {order:result.order,preview:result.preview,maximumDebit:result.maximumDebit};},
  async prepare(intent:CryptoIntentRow):Promise<PreparedCryptoSubmission>{
   if(intent.account_id!==accountId)throw Error('Crypto account changed');
   const result=await review(intent.order_request);
   if(z.object({symbol:z.string()}).parse(intent.review_result).symbol!==result.preview.symbol)throw Error('Pair symbol changed; review again');
   const {currency_pair_id:_,...parameters}=result.order;
   let attempted=false;
   return {scope:{accountId,accountNumber:result.account.accountNumber,cryptoAccountNumber:result.account.cryptoAccountNumber,
    clientRef:intent.ref_id,symbol:result.preview.symbol,order:result.order},maximumDebit:result.maximumDebit,
    ...(result.order.side==='sell'?{sellAvailability:{quantity:result.preview.quantityAvailable!,observedAt:result.preview.observedAt}}:{}),send:async()=>{
    if(attempted)throw Error('Crypto submission already attempted');attempted=true;signal.throwIfAborted();
    return write('place_crypto_order',{...parameters,symbol:result.preview.symbol,rhs_account_number:result.account.rhsAccountNumber,ref_id:intent.ref_id},signal);
   }};
  },
  async observe(intent:CryptoIntentRow){
   const bound=await scope(intent),{account}=await binding();
   if(bound.accountNumber!==account.accountNumber||bound.cryptoAccountNumber!==account.cryptoAccountNumber)throw Error('Crypto account binding changed');
   const orders=await cryptoReadPages(async(name,args,s)=>{const raw=await read(name,args,s);const echo=z.object({data:z.object({rhs_account_number:z.string(),crypto_account_number:z.string().optional()})}).parse(raw).data;if(echo.rhs_account_number!==account.rhsAccountNumber||(echo.crypto_account_number!==undefined&&echo.crypto_account_number!==account.cryptoAccountNumber))throw Error('Crypto order account mismatch');return raw;},'get_crypto_orders',{rhs_account_number:account.rhsAccountNumber},signal);
   const approvals=intent.approval_ref?z.object({data:z.object({approvals:z.array(z.unknown()).max(100).nullable()})}).parse(await read('get_trade_approvals',{account_number:account.accountNumber,approval_ids:[intent.approval_ref]},signal)).data.approvals??[]:[];
   return {scope:bound,observedAt:new Date().toISOString(),read:{accountId,complete:true,orders,approvals}};
  },
  async cancel(intent:CryptoIntentRow){
   if(intent.account_id!==accountId||intent.status!=='placed'||!intent.provider_order_ref)throw Error('A bound crypto order is required to cancel');
   const {account}=await binding();
   return write('cancel_crypto_order',{rhs_account_number:account.rhsAccountNumber,order_id:intent.provider_order_ref},signal);
  },
 };
}
export type CryptoTransport=ReturnType<typeof createCryptoTransport>;

/** Captured place_crypto_order contract: market dollar buys can debit up to the
 * 1% buy collar; reserve upward to cents plus fee rounding. Limit dollar buys
 * have no collar buffer. Reconciliation still refuses any debit over this cap. */
export function cryptoBuyMaximumDebit(dollars:string,type:'market'|'limit'):string {
 const cent=amount('0.01'),value=amount(dollars);
 const bounded=type==='market'?((value*101n+100n*cent-1n)/(100n*cent))*cent:value;
 return format(bounded+cent);
}
