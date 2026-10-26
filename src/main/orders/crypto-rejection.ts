/** Extract bounded provider error fields, never guidance or credential fields. */
function errorTexts(raw:unknown):string[] {
 const text:string[]=[];let remaining=80;
 const fields=new Set(['error','errors','message','detail','details','non_field_errors','data','limit_price','quantity','dollar_amount','symbol','rhs_account_number','ref_id','time_in_force']);
 function visit(value:unknown,depth:number){
  if(depth>5||remaining--<=0)return;
  if(typeof value==='string'){
   if(value.length>4096)return;
   text.push(value);return;
  }
  if(Array.isArray(value)){for(const item of value.slice(0,20))visit(item,depth+1);return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value).slice(0,40))if(fields.has(key))visit(item,depth+1);
 }
 visit(raw,0);
 return text;
}
export function cryptoRejectionCode(raw:unknown):string {
 const text=errorTexts(raw).map(value=>value.toLowerCase());
 const rules:[string,RegExp][]=[
  ['buying_power',/\binsufficient (?:buying power|funds|balance)\b/],
  ['account_restricted',/\baccount (?:is )?(?:restricted|disabled|deactivated)\b/],
  ['region_restricted',/\b(?:not available|not supported|not permitted) in (?:your|this) (?:state|region|jurisdiction)\b/],
  ['agentic_disabled',/\b(?:not agentic.enabled|agentic (?:trading )?(?:is )?not (?:enabled|allowed))\b/],
  ['crypto_account_missing',/\bno crypto account found\b/],
  ['minimum_size',/\b(?:below|less than) (?:the )?minimum (?:order |trade )?(?:size|amount|quantity|notional)\b/],
  ['price_increment',/\b(?:invalid (?:limit )?price increment|(?:limit )?price must be (?:a )?multiple of)\b/],
  ['quantity_increment',/\b(?:invalid quantity increment|quantity must be (?:a )?multiple of)\b/],
  ['dollar_sizing',/\bdollar_amount (?:is )?(?:not supported|not allowed|unsupported)\b/],
  ['price_bounds',/\b(?:limit )?price (?:is )?(?:too high|too low|outside (?:the )?(?:allowed|permitted) range)\b/],
 ];
 const matches=rules.filter(([,pattern])=>text.some(value=>pattern.test(value)));
 // Ambiguous/unrecognized content remains generic; never invent a specific cause.
 return matches.length===1?'provider_invalid_request_'+matches[0][0]:'provider_invalid_request';
}


/** Keep the broker explanation intact, including account/region names. Only
 * credential-shaped content is removed; React renders this as plain text. */
export function cryptoRejectionDiagnostic(raw:unknown):string|null {
 const message=[...new Set(errorTexts(raw))].slice(0,4).join('\n')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [credential removed]')
  .replace(/((?:["']?)(?:access_token|refresh_token|id_token|client_secret|api[_ -]?key|password|token)(?:["']?)\s*[:=]?\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[credential removed]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[credential removed]')
  .replace(/https?:\/\/[^\s<>"']+/gi,'[URL removed]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
  .trim();
 return message?message.slice(0,2000):null;
}

/** Keep success evidence untouched; diagnostics see both MCP error channels. */
export function cryptoErrorDetails(raw:unknown):unknown {
 const result=raw as {structuredContent?:unknown;content?:unknown};
 const blocks=Array.isArray(result?.content)?result.content:[];
 return {errors:[result?.structuredContent,...blocks.slice(0,20).flatMap(block=>{
  if(block?.type!=='text'||typeof block.text!=='string'||block.text.length>16384)return [];
  try{return [JSON.parse(block.text)];}catch{return [block.text];}
 })]};
}
