import type {SubmissionResult} from '../trading/dispatch';
import type {PlacementResponse} from './contract';
/** Retain broker-specific envelopes inside this adapter. */
export function placedOrderRef(data:unknown):string|null{
 if(typeof data!=='object'||data===null)return null;
 const record=data as {data?:{order?:{id?:unknown}};order?:{id?:unknown};id?:unknown};
 const id=record.data?.order?.id??record.order?.id??record.id;
 return typeof id==='string'&&id.length>0&&id.length<=128?id:null;
}
export function classifyRobinhoodSubmission(response:PlacementResponse):SubmissionResult{
 if(response.isError)return response.errorCategory==='invalid_request'
  ?{state:'rejected',code:'provider_invalid_request',evidence:response.data}
  :{state:'unknown',code:'tool_error',evidence:response.data};
 const providerRef=placedOrderRef(response.data);
 return providerRef?{state:'accepted',providerRef,evidence:response.data}:{state:'unknown',code:'missing_order_ref',evidence:response.data};
}
