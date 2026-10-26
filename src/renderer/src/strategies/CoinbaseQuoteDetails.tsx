import {DEFAULT_QUOTE_CHANGE_TOLERANCE_BPS,type CoinbaseOrderReview} from '../../../shared/coinbase-orders';
import {cryptoLogo} from '../crypto-logos';

const number=(value:string,max=8)=>Number(value).toLocaleString('en-US',{maximumFractionDigits:max});
const money=(value:string)=>Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

export function CoinbaseQuoteDetails({review}:{review:CoinbaseOrderReview}){
 return <div aria-label="Order quote details">
  <ul className="divide-y divide-border">{review.orders.map((order,index)=>{
   const symbol=order.product.split('-')[0],logo=cryptoLogo(symbol);
   const previous=review.previousQuoteOrders?.find(o=>o.product===order.product&&o.side===order.side);
   const moved=previous&&Number(previous.limitPrice)>0?(Number(order.limitPrice)/Number(previous.limitPrice)-1)*100:0;
   const changed=(field:'baseSize'|'limitPrice'|'notional'|'fee')=>previous!==undefined&&Number(previous[field])!==Number(order[field]);
   const changedTerms=previous&&(['baseSize','limitPrice','notional','fee'] as const).some(changed);
   return <li key={`${order.product}:${index}`} className="py-4 first:pt-0 last:pb-0">
    <div className="flex items-start gap-3">
     {logo?<img src={logo} alt="" className="mt-1 size-8 shrink-0 rounded-full"/>:<span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs" aria-hidden>{symbol.slice(0,2)}</span>}
     <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
       <p className="text-sm font-medium"><span className={order.side==='sell'?'text-foreground':'text-success'}>{order.side==='sell'?'Sell':'Buy'}</span> {symbol} <span className="font-normal text-muted-foreground">{order.orderType==='market'?'market':'limit'}</span></p>
       <p aria-label="Estimated value" className={`font-mono text-base tabular-nums ${changed('notional')?'text-error':''}`}>≈ {money(order.notional)}</p>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
       <p className="font-mono tabular-nums"><span aria-label={order.orderType==='market'?'Estimated price':'Limit price'} className={changed('limitPrice')?'text-error':undefined}>{order.orderType==='market'?'≈ ':''}{number(order.limitPrice)}</span></p>
      </div>
      {changedTerms&&<details className="mt-1 text-xs">
     <summary className="cursor-pointer text-error">{moved!==0?`Quote moved ${moved>0?'+':''}${moved.toFixed(2)}%`:'Order amounts updated'}</summary>
     <dl className="mt-2 space-y-1 text-muted-foreground">{([
      ['baseSize','Quantity'],['limitPrice',order.orderType==='market'?'Estimated price':'Limit price'],['notional','Estimated value'],['fee','Estimated fee'],
     ] as const).filter(([field])=>changed(field)).map(([field,label])=><div key={field} className="flex flex-wrap justify-between gap-x-3"><dt>{label}</dt><dd className="tabular-nums">{number(previous![field],12)} → <span className="text-error">{number(order[field],12)}</span></dd></div>)}</dl>
      </details>}
     </div>
    </div>
   </li>;
  })}</ul>
  <p className="mt-4 text-[11px] text-muted-foreground">Quote-change tolerance: {DEFAULT_QUOTE_CHANGE_TOLERANCE_BPS/100}%.</p>
 </div>;
}
