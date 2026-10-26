import { coinbaseGet } from './rest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoinbaseKey } from './key';
import { decimalToScaledInteger, scaledIntegerToDecimal } from '../allocations/decimal';
import { CoinbaseError } from './errors';

function checked<T extends z.ZodType>(schema:T,raw:unknown,stage:string):z.infer<T> {
 const result=schema.safeParse(raw);
 if(!result.success)throw new CoinbaseError('provider',stage+':'+result.error.issues.slice(0,3).map(issue=>issue.path.join('.')+'='+issue.code).join(','));
 return result.data;
}
const asset = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,39}$/);
const decimal = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/).max(80);
const walletSchema = z.object({ uuid: z.uuid(), currency: asset, retail_portfolio_id: z.uuid(), available_balance:z.object({value:decimal,currency:asset}).optional(), hold:z.object({value:decimal,currency:asset}).optional() });
const feeSchema=z.object({amount:decimal,currency:asset});
const transactionSchema = z.object({ id: z.uuid(), type: z.string().min(1).max(80), status: z.string().min(1).max(80),
  amount: z.object({ amount: decimal, currency: asset }), created_at: z.iso.datetime({offset:true}), resource_path: z.string(),
  advanced_trade_fill:z.object({commission:decimal,product_id:z.string().regex(/^[A-Z0-9._]+-[A-Z0-9._]+$/),order_id:z.string().max(200)}).optional(),
  network:z.object({transaction_fee:feeSchema.optional()}).optional(),
});
export interface CoinbasePortfolioWallet {id:string;asset:string}
export interface CoinbaseHistory {
  formatVersion?: 2;
  state: 'complete' | 'partial';
  reason: 'access' | 'page_limit' | 'wallet_limit' | 'provider' | null;
  checkpoint?: { completed: string[]; queries: Record<string,string>; refresh?: boolean; seen?: Record<string,string[]> };
  wallets?: { wallet: string; asset: string; available: string | null; held: string | null; balance?:string; balancePrecision?:number }[];
  walletCount: number;
  completedWallets: number;
  transactions: { id: string; wallet: string; asset: string; amount: string; type: string; status: string; occurredAt: string; fee?:{asset:string;amount:string}; orderRef?:string; networkFee?:{asset:string;amount:string} }[];
}
export type CoinbaseHistoryRead = (key: CoinbaseKey, portfolio: string, signal: AbortSignal, previous?: CoinbaseHistory, portfolioWallets?:CoinbasePortfolioWallet[]) => Promise<CoinbaseHistory>;

/** Only fixed Coinbase GET routes. Pagination never chooses an origin or sends credentials elsewhere. */
export function createCoinbaseHistoryReader(fetcher: typeof fetch = fetch, pageBudget = 95): CoinbaseHistoryRead {
  return async (key, portfolio, parent, previous, portfolioWallets=[]) => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(55_000)]);
    const hash = (value: string) => createHash('sha256').update(portfolio + ':' + value).digest('hex');
    let requests = 0;
    const request = coinbaseGet(key, signal, fetcher);
    const get = (path: string, query: URLSearchParams) => { requests++; return request(path, query); };
    const wallets = new Map<string,z.infer<typeof walletSchema> & {balance?:string;balancePrecision?:number}>();
    let cursor = ''; const cursors = new Set<string>();
    do {
      const page = checked(z.object({accounts:z.array(walletSchema).max(250),has_next:z.boolean(),cursor:z.string().max(2048).optional()})
        ,await get('/api/v3/brokerage/accounts',new URLSearchParams({limit:'250',...(cursor?{cursor}:{})})),'wallets');
      for (const wallet of page.accounts) {
        if(wallet.retail_portfolio_id !== portfolio) throw new CoinbaseError('scope');
        if(wallets.has(wallet.uuid)) throw new CoinbaseError('provider');
        wallets.set(wallet.uuid,wallet);
      }
      if(!page.has_next)break;
      if(!page.cursor || cursors.has(page.cursor))throw new CoinbaseError('provider');
      cursors.add(page.cursor);cursor=page.cursor;
      if(cursors.size>=10) return {state:'partial',reason:'wallet_limit',walletCount:wallets.size,completedWallets:0,transactions:[]};
    } while(true);
    // Portfolio breakdown proves the scope of wallets (including staked balances)
    // that Advanced Trade's liquid-account list does not expose.
    for(const expected of portfolioWallets) {
      z.uuid().parse(expected.id);asset.parse(expected.asset);
      const found=wallets.get(expected.id);
      if(found) {if(found.currency!==expected.asset)throw new CoinbaseError('scope');continue;}
      const account=checked(z.object({data:z.object({id:z.uuid(),currency:z.object({code:asset,exponent:z.number().int().min(0).max(36).optional()}),balance:feeSchema,resource_path:z.string()})})
        ,await get(`/v2/accounts/${expected.id}`,new URLSearchParams()),'portfolio_wallet').data;
      if(account.id!==expected.id||account.resource_path!==`/v2/accounts/${expected.id}`||account.currency.code!==expected.asset||account.balance.currency!==expected.asset)throw new CoinbaseError('scope');
      wallets.set(expected.id,{uuid:expected.id,currency:expected.asset,retail_portfolio_id:portfolio,balance:account.balance.amount,balancePrecision:account.currency.exponent});
    }
    const walletIds = new Set([...wallets.keys()].map(hash));
    if (previous?.transactions.some(tx=>!walletIds.has(tx.wallet))) throw new CoinbaseError('scope');
    const resume = previous?.formatVersion===2 ? previous.checkpoint : undefined;
    const checkpoint = { completed: [...(resume?.completed??[])], queries: {...resume?.queries}, refresh:resume?.refresh, seen:{...resume?.seen} };
    if(checkpoint.completed.some(id=>!walletIds.has(id)) || Object.keys(checkpoint.queries).some(id=>!walletIds.has(id)))throw new CoinbaseError('scope');
    const result:CoinbaseHistory={formatVersion:2,state:'complete',reason:null,walletCount:wallets.size,completedWallets:checkpoint.completed.length,
      transactions:[...(previous?.transactions??[])],wallets:[...wallets.values()].map(w=>{
        if((w.available_balance && w.available_balance.currency!==w.currency)||(w.hold && w.hold.currency!==w.currency))throw new CoinbaseError('scope');
        return {wallet:hash(w.uuid),asset:w.currency,balancePrecision:w.balancePrecision,available:w.available_balance?.value??null,held:w.hold?.value??null,balance:w.balance??(w.available_balance&&w.hold?scaledIntegerToDecimal(decimalToScaledInteger(w.available_balance.value,36)+decimalToScaledInteger(w.hold.value,36),36):undefined)};
      })};
    const ids = new Map(result.transactions.map((tx,index)=>[tx.id,index]));
    const initial = new Set(ids.keys());
    const canStopAtKnown = previous?.formatVersion===2 && (previous?.state==='complete'||resume?.refresh) && !previous!.transactions.some(tx=>!['completed','canceled','expired','failed'].includes(tx.status));
    const partial = (reason:CoinbaseHistory['reason']) => {result.state='partial';result.reason=reason;result.checkpoint=checkpoint;return result;};
    for (const wallet of wallets.values()) {
      const walletId=hash(wallet.uuid);
      if(checkpoint.completed.includes(walletId))continue;
      if(requests>=pageBudget)return partial('page_limit');
      const path = `/v2/accounts/${wallet.uuid}/transactions`;
      let query = checkpoint.queries[walletId] ? new URLSearchParams(checkpoint.queries[walletId]) : new URLSearchParams({limit:'100',order:'desc'});
      if([...query.keys()].some(k=>!['limit','order','starting_after','ending_before'].includes(k)))throw new CoinbaseError('scope');
      const visited = new Set<string>(checkpoint.seen[walletId]??[]);
      while(true) {
        if(requests>=pageBudget)return partial('page_limit');
        let raw:unknown;
        try {raw=await get(path,query);} catch(error) {
          if(error instanceof CoinbaseError && error.code==='authentication') {return partial('access');}
          if(parent.aborted)throw error;
          return partial('provider');
        }
        const page = checked(z.object({data:z.array(transactionSchema).max(100),pagination:z.object({next_uri:z.string().max(4096).nullable()})}),raw,'transactions');
        let foundKnown=false;
        for(const tx of page.data) {
          if(tx.resource_path !== `${path}/${tx.id}` || tx.amount.currency !== wallet.currency)throw new CoinbaseError('scope');
          const entry={id:hash(wallet.uuid+':'+tx.id),wallet:hash(wallet.uuid),asset:tx.amount.currency,amount:tx.amount.amount,type:tx.type,status:tx.status,occurredAt:new Date(tx.created_at).toISOString(),
            ...(tx.advanced_trade_fill?{fee:{asset:tx.advanced_trade_fill.product_id.split('-')[1],amount:tx.advanced_trade_fill.commission},orderRef:tx.advanced_trade_fill.order_id}:{}),
            ...(tx.network?.transaction_fee?{networkFee:{asset:tx.network.transaction_fee.currency,amount:tx.network.transaction_fee.amount}}:{})};
          const index=ids.get(entry.id);
          if(index!==undefined){
            const old=result.transactions[index];
            // Pending transactions may settle; settled monetary evidence cannot silently change.
            if(old.wallet!==entry.wallet || old.asset!==entry.asset || (old.status==='completed' && (['id','wallet','asset','amount','type','status','occurredAt'] as const).some(field=>old[field]!==entry[field]) || (old.fee && (old.fee.amount!==entry.fee?.amount || old.fee.asset!==entry.fee?.asset))))throw new CoinbaseError('provider');
            result.transactions[index]=entry;
          }else{ids.set(entry.id,result.transactions.length);result.transactions.push(entry);}
          if(initial.has(entry.id) && Date.parse(entry.occurredAt)<Date.now()-7*86400000)foundKnown=true;
        }
        if(!page.pagination.next_uri || (canStopAtKnown && foundKnown))break;
        const next = new URL(page.pagination.next_uri,'https://api.coinbase.com');
        if(next.origin!=='https://api.coinbase.com' || next.pathname!==path || next.hash || next.username || next.password ||
          [...next.searchParams.keys()].some(k=>!['limit','order','starting_after','ending_before'].includes(k)))throw new CoinbaseError('scope');
        if(visited.has(next.href))throw new CoinbaseError('provider');visited.add(next.href);
        query=next.searchParams;checkpoint.queries[walletId]=query.toString();checkpoint.seen[walletId]=[...visited];
      }
      checkpoint.completed.push(walletId);delete checkpoint.queries[walletId];delete checkpoint.seen[walletId];result.completedWallets++;
    }
    // Catch up wallet heads after a resumed backfill before declaring current coverage.
    if(resume && !resume.refresh) {result.state='partial';result.reason='page_limit';result.checkpoint={completed:[],queries:{},refresh:true};}
    return result;
  };
}
