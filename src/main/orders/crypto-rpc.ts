import {CryptoPreviewPriceMismatch} from './crypto-preview-price';
import {cryptoFailureSite} from './crypto-failure-site';
import {CryptoReviewFailure} from './crypto-review-error';
import {RobinhoodReadFailure} from '../robinhood-read-error';
import {ZodError} from 'zod';
import {ConnectionFailure} from '../connection-errors';
import type {CryptoOrderReply,CryptoOrderResult} from '../../shared/crypto-orders';

// Only application-authored messages may cross this boundary. Never forward
// arbitrary provider/transport/SQL errors, which may contain private values.
const messages:Record<string,string>={
 'Crypto preview account mismatch':'Robinhood’s preview named a different linked crypto account. The preview was refused.',
 'Crypto preview identity mismatch':'Robinhood’s preview did not match the requested market, side, or order type.',
 'Crypto preview quantity mismatch':'Robinhood’s preview returned a different coin quantity.',
 'Crypto preview limit mismatch':'Robinhood’s preview returned a different limit price. The preview was refused.',
 'Crypto pair currency mismatch':'The selected crypto pair does not match its USD currency metadata.',
 'Crypto symbol ambiguous':'Robinhood returned more than one market with the same crypto symbol.',
 'Repeated provider cursor':'Robinhood repeated a catalog page, so the market lookup could not finish.',
 'Too many provider pages':'Robinhood’s market catalog exceeded the supported page limit.',
 'Too many provider rows':'Robinhood’s market catalog exceeded the supported row limit.',
 'Crypto transport unavailable':'This background host does not have the crypto trading transport. Restart Opentake completely.',
 'Credential binding mismatch':'The saved connection does not match its owner/account binding. Reconnect through Connections.',
 'Database operation failed.':'A local database operation failed while preparing the review.',

 'Select an agentic Robinhood account':'Select an agentic Robinhood account in Connections, then try again.',
 'Select the order’s original agentic account':'Select the order’s original Robinhood account in Connections.',
 'Select the order’s original account':'Select the order’s original Robinhood account in Connections.',
 'Database busy':'Opentake is busy with a data operation. Wait for it to finish.',
 'Crypto trading is currently disabled':'Crypto trading is currently unavailable. Check your connection and trading settings.',
 'Enter a positive USD amount and limit price using decimal numbers':'Enter a positive USD amount (up to two decimal places) and a positive limit price. Use numbers without dollar signs or commas.',
 'Crypto execution currently requires a USD-sized limit buy':'Only USD-sized crypto limit buys are currently supported.',
 'Crypto order is not eligible; refresh its account and pair checks':'This order did not pass account or market eligibility checks. Check the amount and price increments, and whether your account can trade this crypto.',
 'Preview does not fit the provider debit cap':'Robinhood’s preview could not verify the maximum debit. No order was submitted.',
 'Robinhood read failed':'Robinhood could not complete the crypto account or preview request. Check the connection and order details.',
 'Crypto pair unavailable or ambiguous':'This crypto market could not be uniquely resolved. Search for the Robinhood pair again.',
 'Crypto account unavailable':'This Robinhood account is not available for agentic crypto trading.',
 'Account binding unavailable':'The selected Robinhood account could not be matched. Refresh your connection.',
 'Account unavailable':'Select an available Robinhood account in Connections.',
 'Insufficient unreserved USD for the maximum order debit':'Not enough unreserved USD for this order, including its maximum fee allowance.',
 'Complete USD cash observation required':'Refresh your Robinhood portfolio before confirming this order.',
 'Fresh account observation required':'Refresh your Robinhood portfolio before confirming this order.',
 'Complete account synchronization required':'Wait for Robinhood account synchronization to finish before confirming.',
 'Wait for open account orders to settle':'Wait for existing account orders to settle before confirming.',
 'Wait for the existing equity submission to reconcile':'Wait for the existing stock order to reconcile before confirming.',
 'Wait for fill attribution to complete':'Wait for existing account fills to reconcile before confirming.',
 'Order already attempted; reconcile it instead of submitting again':'This order was already attempted. Refresh its status; do not submit a replacement.',
 'Review expired or order already attempted':'This review expired or was already submitted. Refresh the order status before making another review.',
};
export async function cryptoRpcReply(action:unknown,work:()=>Promise<CryptoOrderResult>):Promise<CryptoOrderReply>{
 try{return {ok:true,value:await work()};}
 catch(caught){
  const error=caught instanceof CryptoReviewFailure?caught.failure:caught;
  let message:string|undefined;
  if(error instanceof ConnectionFailure)message={reauth_required:'Sign in to Robinhood again in Connections.',storage_locked:'Sign in to Robinhood again in Connections.',transient:'Robinhood is temporarily unavailable.',cancelled:'The crypto request was cancelled.',busy:'Robinhood is busy. Wait for the current request to finish.'}[error.code];
  else if(error instanceof RobinhoodReadFailure)message=error.publicMessage();
  else if(error instanceof CryptoPreviewPriceMismatch)message=error.publicMessage();
  else if(error instanceof ZodError)message='Robinhood crypto data could not be validated. Refresh the connection and try reviewing again.';
  else if(error instanceof Error)message=messages[error.message];
  const timeout=error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);
  if(!message)message=timeout?'The crypto request timed out.':'The crypto request could not be completed.';
  if(caught instanceof CryptoReviewFailure){
   const stage={account:'checking the selected account',provider:'contacting Robinhood for the review',save:'saving the order review locally',display:'loading the saved review'}[caught.stage];
   const value=error as {code?:unknown;cause?:{code?:unknown};name?:unknown}|null;
   const code=value?.cause?.code??value?.code;
   const reasons:Record<string,string>={ECONNRESET:'The network connection was reset.',ECONNREFUSED:'The network connection was refused.',ENOTFOUND:'The server address could not be resolved.',UND_ERR_CONNECT_TIMEOUT:'The network connection timed out.',401:'Robinhood authorization was rejected.',403:'Robinhood refused access.',429:'Robinhood rate-limited the request.',23514:'The database rejected the review because a constraint was not satisfied.',23503:'The database could not match a required record.',42703:'The database schema is missing a required column.'};
   const reason=(typeof code==='string'||typeof code==='number')&&Object.hasOwn(reasons,String(code))?reasons[String(code)]:null;
   message=`Failed while ${stage}. ${reason??message}`;
  }
  const site=cryptoFailureSite(error);
  if(site)message+=` Diagnostic: ${site}.`;
  if(action==='review')message+=' This review did not submit an order.';
  if(action==='confirm')message+=' Refresh order status before trying anything else; do not submit a replacement.';
  return {ok:false,message};
 }
}
