import type {ReactNode} from 'react';
import {Button} from '../components/ui/button';

/** Shared account placement and capital actions below a Take's holdings. */
export function InvestmentControls({accounts,deposit,withdraw}:{accounts?:ReactNode;deposit?:{onClick:()=>void;disabled?:boolean};withdraw?:{onClick:()=>void;disabled?:boolean}}){
 return <div className="mt-4 space-y-3">
  {accounts}
  {(deposit||withdraw)&&<div className="grid grid-cols-2 gap-2">
   {deposit&&<Button className="w-full" onClick={deposit.onClick} disabled={deposit.disabled}>Deposit</Button>}
   {withdraw&&<Button className="w-full" variant="outline" onClick={withdraw.onClick} disabled={withdraw.disabled}>Take money out</Button>}
  </div>}
 </div>;
}
