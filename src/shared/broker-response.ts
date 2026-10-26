import {brokerErrors,brokerStates} from './broker-diagnostics';
export type DiagnosticResponse=string|number|boolean|null|DiagnosticResponse[]|{[key:string]:DiagnosticResponse};
const numeric=new Set(['last_trade_price','last_price','ask_price','bid_price','previous_close','adjusted_previous_close','last_extended_hours_trade_price','last_non_reg_trade_price','open_price','close_price','high_price','low_price','price','bid','ask','best_bid','best_ask','size','quantity','filled_quantity','remaining_quantity','filled_size','base_size','quote_size','notional','amount','value','balance','available_balance','hold','fee','fees','commission','total_fees','average_filled_price','limit_price','stop_price','open','high','low','close','volume','start','end','timestamp','sequence_num','base_increment','quote_increment','base_min_size','quote_min_size','buying_power']);
const booleans=new Set(['success','accepted','has_next','hasMore','trading_disabled','cancel_only','limit_only','post_only','is_disabled','can_trade','can_view','can_transfer']);
const containers=new Set(['quote','quotes','close','historicals','structuredContent','data','results','orders','order','fills','positions','spot_positions','candles','wallets','products','product','pricebooks','pricebook','bids','asks','trades','portfolio','breakdown','accounts','balances','preview','success_response','error_response','errors','errs','warnings','order_configuration','market_market_ioc','limit_limit_gtc']);
/** Positive allowlist, bounded at capture AND read. Never persist arbitrary provider text. */
export function brokerResponseDetails(raw:unknown):DiagnosticResponse|undefined{
 let remaining=250,truncated=false;
 function visit(value:unknown,depth:number):DiagnosticResponse|undefined{
  if(depth>7||remaining--<=0){truncated=true;return undefined;}
  if(typeof value==='boolean'||value===null)return value;
  if(Array.isArray(value)){
   if(value.length>20)truncated=true;
   return value.slice(0,20).map(v=>visit(v,depth+1)).filter((v):v is DiagnosticResponse=>v!==undefined);
  }
  if(!value||typeof value!=='object')return undefined;
  const result:Record<string,DiagnosticResponse>={};
  for(const [key,v] of Object.entries(value)){
   if(key==='truncated'&&v===true){truncated=true;continue;}
   if(numeric.has(key)&&((typeof v==='number'&&Number.isFinite(v))||(typeof v==='string'&&/^-?\d{1,40}(\.\d{1,36})?$/.test(v))))result[key]=v;
   else if(booleans.has(key)&&typeof v==='boolean')result[key]=v;
   else if(['symbol','product','product_id','asset','currency','base','quote','base_currency_id','quote_currency_id'].includes(key)&&typeof v==='string'&&/^[A-Z][A-Z0-9.-]{0,19}$/.test(v))result[key]=v;
   else if(['state','status'].includes(key)&&typeof v==='string'&&[...brokerStates,'open','queued','partially_filled','expired','failed','done','settled'].includes(v.toLowerCase() as never))result[key]=v;
   else if(['symbols','product_ids'].includes(key)&&Array.isArray(v))result[key]=v.filter((s):s is string=>typeof s==='string'&&/^[A-Z][A-Z0-9.-]{0,19}$/.test(s)).slice(0,20);
   else if(key==='side'&&typeof v==='string'&&['buy','sell'].includes(v.toLowerCase()))result[key]=v;
   else if(key==='code'&&brokerErrors.includes(v as never))result[key]=v as string;
   else if(containers.has(key)){const child=visit(v,depth+1);if(child!==undefined)result[key]=child;}
  }
  return result;
 }
 // MCP tools may wrap JSON in a text content block. Parse only bounded JSON;
 // arbitrary text, including provider messages and credentials, is never copied.
 let payload=raw;
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
  const envelope=raw as Record<string,unknown>;
  if(envelope.structuredContent!==undefined)payload=envelope.structuredContent;
  else if(Array.isArray(envelope.content)){
   const blocks=envelope.content.filter(v=>v&&typeof v==='object'&&v.type==='text');
   if(blocks.length===1&&typeof blocks[0].text==='string'&&blocks[0].text.length<=450000){try{payload=JSON.parse(blocks[0].text);}catch{/* No free-form text. */}}
  }
 }
 const result=visit(payload,0);
 return truncated?{truncated:true,data:result??null}:result;
}
