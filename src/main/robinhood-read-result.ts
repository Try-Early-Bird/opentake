import {RobinhoodReadFailure,readFailureCategory} from './robinhood-read-error';
/** Provider text can include a separate prose guide. Only JSON is data; never
 * execute or interpret guide text, and never ignore malformed JSON-looking data. */
export function robinhoodReadData(raw:unknown,name:string):unknown {
 const result=raw as {isError?:boolean;structuredContent?:unknown;content?:{type?:unknown;text?:unknown}[];_meta?:{rh_error_category?:unknown}};
 if(!result||typeof result!=='object')throw new RobinhoodReadFailure(name,'invalid_response');
 if(result.isError)throw new RobinhoodReadFailure(name,result._meta?.rh_error_category);
 if(result.structuredContent!==undefined)return result.structuredContent;
 if(!Array.isArray(result.content))throw new RobinhoodReadFailure(name,'invalid_response');
 const values:unknown[]=[];
 for(const block of result.content){
  if(block?.type!=='text'||typeof block.text!=='string')continue;
  const text=block.text.trim();
  try{values.push(JSON.parse(text));}
  catch{if(/^[\[{]/.test(text))throw new RobinhoodReadFailure(name,'invalid_response');}
 }
 if(!values.length)throw new RobinhoodReadFailure(name,'invalid_response');
 return values.length===1?values[0]:values;
}
export async function robinhoodReadCall(name:string,call:()=>Promise<unknown>){
 let result:unknown;
 try{result=await call();}catch(error){throw new RobinhoodReadFailure(name,readFailureCategory(error));}
 return robinhoodReadData(result,name);
}
