import {diagnosticLevel,type DiagnosticRow} from './diagnostics';
export interface LogCall {id:string;row:DiagnosticRow;request?:DiagnosticRow;response?:DiagnosticRow;broker:boolean}
/** Pair before filtering/pagination so each retained call keeps both halves. */
export function logCalls(rows:DiagnosticRow[]):LogCall[]{
 const calls=new Map<string,LogCall>();
 rows.forEach((row,index)=>{
  const broker=['broker.called','broker.returned','broker.failed'].includes(row.event);
  const id=broker&&row.details.callId?`${row.source}:${row.details.callId}`:`${row.source}:${row.time}:${row.event}:${index}`;
  const call=calls.get(id)??{id,row,broker};
  if(broker){if(row.event==='broker.called')call.request=row;else if(!call.response||row.time>call.response.time)call.response=row;call.row=call.response??call.request??row;}
  calls.set(id,call);
 });
 return [...calls.values()].sort((a,b)=>b.row.time.localeCompare(a.row.time));
}
export function callLevel(call:LogCall){return diagnosticLevel(call.row);}
export function callTitle(row:DiagnosticRow){
 const operation=row.operation??row.stage??row.event;
 if(/histor|candles/.test(operation))return 'Historicals';
 if(/quote|pricebook|prices/.test(operation))return 'Quotes';
 if(/balance|wallet|buying_power/.test(operation))return 'Balances';
 if(/submit_order|place.*order/.test(operation))return 'Place order';
 if(/preview|review.*order/.test(operation))return 'Preview orders';
 if(/cancel.*order/.test(operation))return 'Cancel order';
 if(/rebalance/.test(operation))return 'Drift check';
 return operation.replace(/[_.]/g,' ').replace(/^./,c=>c.toUpperCase());
}
