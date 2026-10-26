import type {InvestmentSummaryData} from './InvestmentSummary';
/** Dollar P&L and P&L percentage share the same net-invested basis.
 * Chart returns remain unitized; never average venue return percentages. */
export function combineInvestmentSummaries(parts:{account:string;data:InvestmentSummaryData}[],complete:boolean):InvestmentSummaryData{
 const compatible=complete&&parts.every(p=>p.data.currency==='USD');
 const total=(field:'value'|'gain')=>compatible&&parts.every(p=>p.data[field]!=null&&Number.isFinite(Number(p.data[field])))?parts.reduce((n,p)=>n+Number(p.data[field]),0):null;
 const value=total('value'),gain=total('gain');
 const netInvested=value!==null&&gain!==null?value-gain:null;
 return {value:value===null?null:String(value),currency:'USD',gain,returnPercent:gain!==null&&netInvested!==null&&netInvested>0?gain/netInvested*100:null,
 positions:parts.flatMap(({account,data})=>data.positions.map(p=>({...p,account,price:data.currency==='USD'?p.price:null,value:data.currency==='USD'?p.value:null}))),
 cash:parts.flatMap(({account,data})=>data.cash.map(c=>({...c,account,value:data.currency==='USD'?c.value:null}))),
 };
}
