import { expect, test, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createCoinbaseHistoryReader } from '../../src/main/coinbase/history';
const portfolio='11111111-1111-4111-8111-111111111111',wallet='22222222-2222-4222-8222-222222222222',tx='33333333-3333-4333-8333-333333333333';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const key={name:'organizations/synthetic/apiKeys/synthetic',privateKey:keys.privateKey.export({type:'sec1',format:'pem'}).toString()};
const accounts={accounts:[{uuid:wallet,currency:'BTC',retail_portfolio_id:portfolio}],has_next:false};
const transaction={id:tx,type:'receive',status:'completed',amount:{amount:'0.00000001',currency:'BTC'},created_at:'2026-10-09T12:00:00Z',resource_path:`/v2/accounts/${wallet}/transactions/${tx}`,description:'not retained',from:{email:'not-retained@example.com'}};
const page=(next:string|null=null)=>({data:[transaction],pagination:{next_uri:next}});
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200});
test('history follows scoped pagination, deduplicates transactions and signs fixed GET routes',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page(`/v2/accounts/${wallet}/transactions?starting_after=${tx}&limit=100`))).mockResolvedValueOnce(response(page()));
 const result=await createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal);
 expect(result).toMatchObject({state:'complete',walletCount:1,completedWallets:1});expect(result.transactions).toHaveLength(1);
 expect(result.transactions[0].amount).toBe('0.00000001');expect(JSON.stringify(result)).not.toContain('not-retained');expect(JSON.stringify(result)).not.toContain(wallet);
 for(const [url,init] of fetcher.mock.calls){
  expect(init.method).toBe('GET');expect(init.redirect).toBe('error');
  const [head,body,sig]=init.headers.Authorization.slice(7).split('.');
  expect(verify('sha256',Buffer.from(head+'.'+body),{key:keys.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url'))).toBe(true);
  expect(JSON.parse(Buffer.from(body,'base64url').toString()).uri).toBe('GET api.coinbase.com'+new URL(url).pathname);
 }
});
test('history rejects another portfolio before fetching any transaction',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response({...accounts,accounts:[{...accounts.accounts[0],retail_portfolio_id:tx}]}));
 await expect(createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal)).rejects.toMatchObject({code:'scope'});expect(fetcher).toHaveBeenCalledTimes(1);
});
test('history does not follow untrusted pagination destinations or other wallet paths',async()=>{
 for(const next of ['https://example.com/steal',`/v2/accounts/${tx}/transactions`]){
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page(next)));
 await expect(createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal)).rejects.toMatchObject({code:'scope'});expect(fetcher).toHaveBeenCalledTimes(2);
 }
});
test('denied transaction history is partial coverage, never empty complete history',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(new Response('',{status:403}));
 expect(await createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal)).toMatchObject({state:'partial',reason:'access',completedWallets:0,transactions:[]});
});
test('history rejects mismatched assets, missing pagination and repeated cursors',async()=>{
 for(const bad of [{data:[{...transaction,amount:{amount:'1',currency:'ETH'}}],pagination:{next_uri:null}},{data:[]}]) {
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(bad));
 await expect(createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal)).rejects.toThrow();
 }
 const next=`/v2/accounts/${wallet}/transactions?starting_after=${tx}`;
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page(next))).mockResolvedValueOnce(response(page(next)));
 await expect(createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal)).rejects.toMatchObject({code:'provider'});
});

test('history resumes a capped wallet traversal and catches up heads before complete coverage',async()=>{
 const next=`/v2/accounts/${wallet}/transactions?starting_after=${tx}`;
 const firstFetch=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page(next)));
 const first=await createCoinbaseHistoryReader(firstFetch,2)(key,portfolio,new AbortController().signal);
 expect(first.state).toBe('partial');expect(first.transactions).toHaveLength(1);
 const older={...transaction,id:'44444444-4444-4444-8444-444444444444',created_at:'2026-10-01T00:00:00Z',resource_path:`/v2/accounts/${wallet}/transactions/44444444-4444-4444-8444-444444444444`};
 const secondFetch=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({data:[older],pagination:{next_uri:null}}));
 const second=await createCoinbaseHistoryReader(secondFetch,2)(key,portfolio,new AbortController().signal,first);
 expect(new URL(secondFetch.mock.calls[1][0]).searchParams.get('starting_after')).toBe(tx);
 expect(second).toMatchObject({state:'partial',checkpoint:{refresh:true}});expect(second.transactions).toHaveLength(2);
 const thirdFetch=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page()));
 const third=await createCoinbaseHistoryReader(thirdFetch,2)(key,portfolio,new AbortController().signal,second);
 expect(third.state).toBe('complete');expect(third.transactions).toHaveLength(2);
});
test('history accepts JSONB key ordering, updates pending evidence, and rejects changed settled amounts',async()=>{
 const read=async(value:unknown,previous?:any)=>createCoinbaseHistoryReader(vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({data:[value],pagination:{next_uri:null}})))(key,portfolio,new AbortController().signal,previous);
 const first=await read({...transaction,status:'pending'});
 first.transactions=first.transactions.map(entry=>Object.fromEntries(Object.entries(entry).reverse())) as typeof first.transactions;
 const settled=await read(transaction,first);expect(settled.transactions[0].status).toBe('completed');
 await expect(read({...transaction,amount:{...transaction.amount,amount:'100'}},settled)).rejects.toMatchObject({code:'provider'});
 expect((await read(transaction,settled)).transactions).toHaveLength(1);
});

test('history includes only additional wallets proven by the portfolio and retains quote fee evidence',async()=>{
 const staked='55555555-5555-4555-8555-555555555555';
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({data:{id:staked,currency:{code:'ETH',exponent:18},balance:{amount:'0.2',currency:'ETH'},resource_path:`/v2/accounts/${staked}`}}))
 .mockResolvedValueOnce(response({data:[{...transaction,type:'advanced_trade_fill',advanced_trade_fill:{commission:'1.5',product_id:'BTC-USD',order_id:'order-1',order_side:'buy'}}],pagination:{next_uri:null}}))
 .mockResolvedValueOnce(response({data:[],pagination:{next_uri:null}}));
 const result=await createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal,undefined,[{id:staked,asset:'ETH'}]);
 expect(result.wallets?.find(w=>w.asset==='ETH')?.balance).toBe('0.2');
 expect(result.wallets?.find(w=>w.asset==='ETH')?.balancePrecision).toBe(18);
 expect(result.transactions[0].fee).toEqual({asset:'USD',amount:'1.5'});
 expect(result.walletCount).toBe(2);expect(JSON.stringify(result)).not.toContain(staked);
 const wrong=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({data:{id:staked,currency:{code:'USD'},balance:{amount:'100',currency:'USD'},resource_path:`/v2/accounts/${staked}`}}));
 await expect(createCoinbaseHistoryReader(wrong)(key,portfolio,new AbortController().signal,undefined,[{id:staked,asset:'ETH'}])).rejects.toMatchObject({code:'scope'});
});

test('upgrading legacy history restarts traversal to enrich already completed wallets with commissions',async()=>{
 const oldFetch=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page()));
 const previous=await createCoinbaseHistoryReader(oldFetch)(key,portfolio,new AbortController().signal);
 previous.formatVersion=undefined;
 previous.checkpoint={completed:[previous.transactions[0].wallet],queries:{}};
 const fetcher=vi.fn().mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response(page()));
 const upgraded=await createCoinbaseHistoryReader(fetcher)(key,portfolio,new AbortController().signal,previous);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(upgraded.state).toBe('complete');expect(upgraded.formatVersion).toBe(2);
});
