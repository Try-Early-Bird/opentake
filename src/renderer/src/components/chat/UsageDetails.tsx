import { ChartNoAxesColumn } from 'lucide-react';
import type { ChatUsage } from '../../../../shared/chat-usage';
import { Dialog,DialogTrigger,DialogContent,DialogTitle,DialogDescription } from '../ui/dialog';
const cost=(usd:number)=>usd>0&&usd<0.000001?'<$0.000001':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(usd);
export function UsageDetails({usage}:{usage?:ChatUsage|null}) {
 const tokens=(n:number|undefined)=><span>{n===undefined?'Unavailable':n.toLocaleString()}</span>;
 const rows:[string,React.ReactNode][]=[[usage?.costKind==='provider-reported'?'Provider-reported cost':'API-equivalent cost',<span>{usage?.costUsd===undefined?'Unavailable':cost(usage.costUsd)}</span>],['Input tokens',tokens(usage?.inputTokens)],['Output tokens',tokens(usage?.outputTokens)],['Reasoning tokens',tokens(usage?.reasoningTokens)],['Cache',<>{tokens(usage?.cacheReadTokens)} read · {tokens(usage?.cacheWriteTokens)} write</>]];
 return <div className="space-y-3 text-sm"><dl className="divide-y divide-border border-b border-border">{rows.map(([label,value])=><div key={label} className="flex items-baseline justify-between gap-5 py-2"><dt>{label}</dt><dd className="font-mono tabular-nums">{value}</dd></div>)}</dl><p className="text-xs text-muted-foreground">{usage?.source?`Reported by ${usage.source}. `:''}{usage?.partial?'Partial usage; this response may have additional unreported usage. ':''}Token categories follow the provider’s reporting and may overlap. Missing values are unavailable, not zero. Cost is not a billing receipt or your subscription charge.</p></div>;
}
/** "1,212 tokens · $0.09" beside a reply; opens the full breakdown. */
export function UsageButton({usage}:{usage?:ChatUsage}) {
 const summary=[usage?.outputTokens!==undefined&&`${usage.outputTokens.toLocaleString()} tokens`,usage?.costUsd!==undefined&&(usage.costUsd>0&&usage.costUsd<0.01?'<$0.01':`$${usage.costUsd.toFixed(2)}`)].filter(Boolean).join(' · ');
 return <Dialog><DialogTrigger type="button" aria-label="Response usage" title="Response usage" className="flex items-center gap-1.5 tabular-nums hover:text-foreground"><ChartNoAxesColumn size={13} aria-hidden="true"/>{summary}</DialogTrigger><DialogContent><DialogTitle>Response usage</DialogTitle><DialogDescription>Usage reported for this response, including its tool rounds.</DialogDescription><UsageDetails usage={usage}/></DialogContent></Dialog>;
}
