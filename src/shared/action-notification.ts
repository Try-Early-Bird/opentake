export interface ActionOrder {id:string;symbol:string;side:string;state:string;amount:string|null;currency:string;venue:string;account:string}
export interface ActionProgress {
 updatedAt?:string;
 id:string;kind:'investment'|'deposit'|'withdrawal'|'close'|'rebalance';state:'pending'|'waiting'|'attention'|'completed'|'cancelled';
 title:string;takeTitle:string;orders:ActionOrder[];filled:number;total:number;
 accounts:{venue:string;label:string;state:string;message:string|null;returned:{currency:string;amount:string}[]}[];
}
export interface ActionChild {
 id:string;strategyId:string;takeTitle:string;kind:ActionProgress['kind'];at:string;venue:string;account:string;
 orders:ActionOrder[];state:string;message:string|null;returned:{currency:string;amount:string}[];receiptIds:string[];
}
export function actionProgress(id:string,children:ActionChild[]):ActionProgress {
 const orders=children.flatMap(c=>c.orders),filled=orders.filter(o=>o.state==='filled').length;
 const attention=children.some(c=>['failed','cancelled','attention'].includes(c.state))||orders.some(o=>['failed','rejected','cancelled','unknown','placement_unknown','reconciliation_required'].includes(o.state));
 const cancelled=children.every(c=>c.state==='cancelled')&&orders.every(o=>!['filled','partially_filled'].includes(o.state));
 const state=cancelled?'cancelled':attention?'attention':children.every(c=>c.state==='completed')&&orders.every(o=>o.state==='filled')?'completed':children.some(c=>['waiting','awaiting_confirmation'].includes(c.state))?'waiting':'pending';
 const approval=children.some(c=>c.state==='awaiting_confirmation');
 const kind=children[0].kind;
 const active={investment:'Investing',deposit:'Adding money',withdrawal:'Taking money out',close:'Closing Take',rebalance:'Rebalancing'}[kind];
 const done={investment:'Investment complete',deposit:'Money invested',withdrawal:'Withdrawal complete',close:'Take closed',rebalance:'Rebalance complete'}[kind];
 return {id,kind,state,title:state==='cancelled'?`${active} · Cancelled`:state==='completed'?done:approval&&!attention?`${{investment:'Investment',deposit:'Deposit',withdrawal:'Withdrawal',close:'Close Take',rebalance:'Rebalance'}[kind]} · Awaiting approval`:`${active}${attention?' · Needs attention':orders.length?` · ${filled} of ${orders.length} filled`:''}`,takeTitle:children[0].takeTitle,orders,filled,total:orders.length,accounts:children.map(c=>({venue:c.venue,label:c.account,state:c.state,message:c.message,returned:c.returned}))};
}
