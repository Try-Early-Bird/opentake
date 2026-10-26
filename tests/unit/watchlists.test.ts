import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createWatchlists} from '../../src/main/watchlists/service';
import type {CoinbaseMarketSnapshot} from '../../src/shared/coinbase-markets';
import type {WatchlistItem} from '../../src/shared/watchlists';
import {callOpentakeTool} from '../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../src/main/opentake-mcp/catalog';

const now=Date.parse('2026-10-22T15:00:00Z');
const coinbase=(id:string):CoinbaseMarketSnapshot=>({market:{id,venue:'coinbase',base:id.split('-')[0],quote:id.split('-')[1],name:'Bitcoin',price:'65000.5',change24h:'1.25',volume24h:null,status:'online',tradingDisabled:false},observedAt:new Date(now).toISOString(),stale:false,source:'public'});
const label=(i:WatchlistItem)=>i.kind==='take'?`take:${i.title}`:`${i.source}:${i.venue}:${i.identity.kind}:${i.symbol}`;

async function fixture(ready=false){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const products:string[]=[];
 let clock=now;
 const lists=createWatchlists(database as never,{robinhoodQuotesReady:async()=>ready,coinbaseDetail:async id=>{products.push(id);if(id==='DOGE-USD')throw Error('offline');return coinbase(id);},now:()=>clock});
 return {db,lists,products,advance:(ms:number)=>{clock+=ms;}};
}

test('a list holds markets from several venues and a take; a page is priced per venue',async()=>{
 const f=await fixture();try{
  const list=await f.lists.create({name:' Watching ',iconEmoji:'👀'});
  expect(list).toMatchObject({name:'Watching',iconEmoji:'👀',itemCount:0,mirror:null});
  // A Robinhood search hit carries the instrument id; the item keys on the ticker.
  const brk={identity:{venue:'robinhood',instance:'production',reference:'synthetic-instrument-id',kind:'stock'},symbol:'BRK-B',name:'Berkshire Hathaway'};
  await f.lists.addItem(list.id,{kind:'market',market:brk});
  await f.lists.addItem(list.id,{kind:'market',market:{...brk,identity:{...brk.identity,reference:'other-id',kind:'equity'},symbol:'BRK.B'}});
  await f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'VTI',kind:'equity'},symbol:'VTI'}});
  // BTC on Coinbase and BTC on Robinhood are two rows.
  await f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'btc-usd',kind:'crypto'},symbol:'BTC-USD'}});
  await f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'synthetic-pair-id',kind:'crypto'},symbol:'BTC'}});
  await f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'DOGE-USD',kind:'crypto'},symbol:'DOGE-USD'}});
  const strategyId=randomUUID();
  await f.db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategyId]);
  await f.db.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Synthetic take','{}',$2 FROM local_owners`,[randomUUID(),strategyId]);
  await f.lists.addItem(list.id,{kind:'take',strategyId});
  await f.lists.addItem(list.id,{kind:'take',strategyId});
  await f.db.query(`INSERT INTO market_quotes(symbol,price,previous_close,observed_at) VALUES('BRK.B',500,400,$1)`,[new Date(now-60_000).toISOString()]);

  // Lists come back without items; items load a page at a time.
  expect(await f.lists.lists()).toEqual([expect.objectContaining({name:'Watching',itemCount:6})]);
  const first=await f.lists.items(list.id,0,3);
  expect(first).toMatchObject({total:6,nextOffset:3,itemsStale:false});
  expect(first.items.map(i=>[label(i),i.kind==='market'?i.quote?.price??i.quoteGap:null])).toEqual([
   ['app:robinhood:equity:BRK.B','500'],['app:robinhood:equity:VTI','connect'],['app:coinbase:crypto:BTC-USD','65000.5'],
  ]);
  expect(first.items[0]).toMatchObject({name:'Berkshire Hathaway',venueLabel:'Robinhood',quote:{changePercent:'25.00',basis:'previous_close',currency:'USD',stale:false}});
  expect(first.items[2]).toMatchObject({quote:{changePercent:'1.25',basis:'24h',currency:'USD'}});
  // Only the page asked for is priced.
  expect(f.products).toEqual(['BTC-USD']);
  const second=await f.lists.items(list.id,3,3);
  expect(second).toMatchObject({total:6,nextOffset:null});
  expect(second.items.map(i=>[label(i),i.kind==='market'?i.quote?.price??i.quoteGap:null])).toEqual([
   ['app:robinhood:crypto:BTC','unsupported'],['app:coinbase:crypto:DOGE-USD','unavailable'],['take:Synthetic take',null],
  ]);
  // Viewed equities join the quote poll, most recent first, and age out.
  expect(f.lists.quoteSymbols()).toEqual(['BRK.B','VTI']);
  f.advance(11*60_000);
  expect(f.lists.quoteSymbols()).toEqual([]);

  // The Add to list menu asks where a target sits.
  expect(await f.lists.membership({kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'x',kind:'etf'},symbol:'brk/b'}})).toEqual([{listId:list.id,itemId:first.items[0].id,source:'app'}]);
  expect(await f.lists.membership({kind:'take',strategyId})).toHaveLength(1);

  await f.lists.removeItem(list.id,first.items[1].id);
  await f.lists.rename(list.id,'Ideas');
  expect(await f.lists.lists()).toEqual([expect.objectContaining({name:'Ideas',itemCount:5})]);
  await f.lists.remove(list.id);
  expect(await f.lists.lists()).toEqual([]);
 }finally{await f.db.close();}
});

test('a missing Robinhood quote waits while connected, and mirrored lists keep their own items',async()=>{
 const f=await fixture(true);try{
  const list=await f.lists.create({name:'Equities'});
  await f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'id',kind:'etf'},symbol:'SPY'}});
  expect((await f.lists.items(list.id)).items[0]).toMatchObject({quote:null,quoteGap:'pending'});
  await expect(f.lists.addItem(list.id,{kind:'market',market:{identity:{venue:'kraken',instance:'production',reference:'XBT',kind:'crypto'},symbol:'XBT'}})).rejects.toThrow('Unsupported market');
  await expect(f.lists.addItem(list.id,{kind:'take',strategyId:randomUUID()})).rejects.toThrow('Take not found');

  const connection=(await f.db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
  const mirrored=(await f.db.query<{id:string}>(`INSERT INTO watchlists(owner_id,name,venue,connection_id,external_id,external_owner_type) SELECT id,'Robinhood list','robinhood',$1,'synthetic-list','custom' FROM local_owners RETURNING id`,[connection])).rows[0].id;
  const item=(await f.db.query<{id:string}>(`INSERT INTO watchlist_items(watchlist_id,kind,source,venue,market_key,identity,symbol,external_object_type,external_object_id)
   VALUES($1,'market','mirror','robinhood','k','{"venue":"robinhood","instance":"production","reference":"AAPL","kind":"equity"}','AAPL','instrument','synthetic-object') RETURNING id`,[mirrored])).rows[0].id;
  await expect(f.lists.rename(mirrored,'Renamed')).rejects.toThrow('Rename or delete this list on its venue');
  // Without Robinhood to write to, a mirrored entry cannot be removed here.
  await expect(f.lists.removeItem(mirrored,item)).rejects.toThrow('Reconnect Robinhood to edit this list');
  // App items may still be added to a mirrored list, after the mirrored entries.
  await f.lists.addItem(mirrored,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'ETH-USD',kind:'crypto'},symbol:'ETH-USD'}});
  expect((await f.lists.lists()).find(l=>l.id===mirrored)?.mirror).toEqual({venue:'robinhood',ownerType:'custom',lastSyncedAt:null,itemsSyncedAt:null});
  const page=await f.lists.items(mirrored);
  expect(page.itemsStale).toBe(true);
  expect(page.items.map(label)).toEqual(['mirror:robinhood:equity:AAPL','app:coinbase:crypto:ETH-USD']);
 }finally{await f.db.close();}
});

test('Robinhood lists mirror read-only: names in one call, a list’s entries only when it is opened',async()=>{
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 try{
  const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
  let clock=now,connected=false,failing=new Set<string>();
  // Synthetic tool payloads in the hosted normalizers' shapes.
  let upstream:Record<string,{name:string;owner:string;items:{object_id:string;object_type:string;symbol:string}[]}>={
   'list-a':{name:'My first list',owner:'custom',items:[{object_id:'inst-aapl',object_type:'instrument',symbol:'AAPL'},{object_id:'inst-brk',object_type:'instrument',symbol:'BRK-B'},{object_id:'pair-btc',object_type:'currency_pair',symbol:'BTC'}]},
   'list-b':{name:'100 Most Popular',owner:'robinhood',items:[{object_id:'inst-spy',object_type:'instrument',symbol:'SPY'}]},
  };
  const reads:string[]=[];
  const lists=createWatchlists(database as never,{robinhoodQuotesReady:async()=>true,coinbaseDetail:async id=>coinbase(id),now:()=>clock,robinhoodLists:{
   connectionId:async()=>connected?connection:null,
   write:async()=>({ok:true}),
   read:async(name,args)=>{
    reads.push(name==='get_watchlists'?name:`${name}:${args.list_id}`);
    if(name==='get_watchlists')return {data:{results:Object.entries(upstream).map(([id,l])=>({id,display_name:l.name,owner_type:l.owner,item_count:l.items.length}))}};
    if(failing.has(String(args.list_id)))throw Error('rejected');
    return {results:upstream[String(args.list_id)].items};
   }}});
  expect(await lists.sync(false)).toEqual({state:'not_connected',syncedAt:null});
  connected=true;

  // Lists only: no entry reads until a list is opened.
  expect(await lists.sync(false)).toMatchObject({state:'synced'});
  expect(reads).toEqual(['get_watchlists']);
  let summaries=await lists.lists();
  expect(summaries.map(l=>[l.name,l.mirror?.ownerType,l.itemCount])).toEqual([['My first list','custom',0],['100 Most Popular','curated',0]]);
  const [a,b]=summaries.map(l=>l.id);
  expect(await lists.items(a)).toMatchObject({items:[],itemsStale:true});
  expect(await lists.syncItems(a)).toMatchObject({state:'synced'});
  expect(reads).toEqual(['get_watchlists','get_watchlist_items:list-a']);
  expect((await lists.items(a)).items.map(label)).toEqual(['mirror:robinhood:equity:AAPL','mirror:robinhood:equity:BRK.B','mirror:robinhood:crypto:BTC']);
  expect(await lists.items(a)).toMatchObject({itemsStale:false});
  expect(await lists.syncItems(a)).toMatchObject({state:'fresh'});
  expect(await lists.sync(false)).toMatchObject({state:'fresh'});
  expect(reads).toHaveLength(2);

  // App items on a mirrored list: one stays; one Robinhood later reports becomes the mirrored entry.
  await lists.addItem(a,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'ETH-USD',kind:'crypto'},symbol:'ETH-USD'}});
  await lists.addItem(a,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'x',kind:'stock'},symbol:'MSFT'}});
  // An app copy of the ticker BRK's entry is about to move to.
  await lists.addItem(a,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'y',kind:'stock'},symbol:'BRK.A'}});

  // Fifteen minutes on: upstream drops AAPL, moves BRK's entry to BRK.A, adds MSFT and an index, and drops list-b.
  clock+=15*60_000;
  upstream={'list-a':{name:'My first list',owner:'custom',items:[{object_id:'inst-brk',object_type:'instrument',symbol:'BRK.A'},{object_id:'pair-btc',object_type:'currency_pair',symbol:'BTC'},{object_id:'inst-msft',object_type:'instrument',symbol:'MSFT'},{object_id:'index-spx',object_type:'index',symbol:'SPX'}]}};
  expect(await lists.sync(false)).toMatchObject({state:'synced'});
  expect(await lists.syncItems(a)).toMatchObject({state:'synced'});
  const page=await lists.items(a);
  expect(page.items.map(label)).toEqual(['mirror:robinhood:equity:BRK.A','mirror:robinhood:crypto:BTC','mirror:robinhood:equity:MSFT','mirror:robinhood:index:SPX','app:coinbase:crypto:ETH-USD']);
  expect(page.items.find(i=>i.kind==='market'&&i.symbol==='SPX')).toMatchObject({quote:null,quoteGap:'unsupported'});
  summaries=await lists.lists();
  expect(summaries.map(l=>l.id)).toEqual([a]);
  expect(await lists.items(b).catch(e=>e.message)).toBe('List not found');

  // A list whose entries cannot be read keeps them, and waits out the interval.
  failing=new Set(['list-a']);
  await expect(lists.syncItems(a,true)).rejects.toThrow('rejected');
  expect((await lists.items(a)).items).toHaveLength(5);
  expect(await lists.syncItems(a)).toMatchObject({state:'fresh'});
  // The list returns upstream: un-archived on the next pass.
  upstream['list-b']={name:'100 Most Popular',owner:'robinhood',items:[]};
  await lists.sync(true);
  expect((await lists.lists()).map(l=>l.name)).toEqual(['My first list','100 Most Popular']);
 }finally{await db.close();}
});

async function mirrorFixture(pages:(listId:string)=>unknown){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const state={connected:true,writes:[] as [string,Record<string,unknown>][],reads:[] as unknown[],refuse:false};
 const lists=createWatchlists(database as never,{robinhoodQuotesReady:async()=>true,coinbaseDetail:async id=>coinbase(id),now:()=>now,robinhoodLists:{
  connectionId:async()=>state.connected?connection:null,
  read:async(name,args)=>{state.reads.push(args);return name==='get_watchlists'
   ?{results:[{id:'custom-1',display_name:'Mine',owner_type:'custom'},{id:'curated-1',display_name:'Popular',owner_type:'robinhood'},
     {id:'options-1',display_name:'Options',owner_type:'custom',allowed_object_types:['option_strategy']}]}
   :pages(String(args.list_id));},
  write:async(name,args)=>{if(state.refuse)throw Error('refused');state.writes.push([name,args]);return {ok:true};},
 }});
 await lists.sync(true);
 const [mine,popular]=(await lists.lists()).map(l=>l.id);
 return {db,lists,state,mine,popular};
}
const entry=(id:string,symbol:string)=>({object_id:id,object_type:'instrument',symbol});

test('a list is read in one call; option lists are left out; a read that says more follow removes nothing',async()=>{
 let page:Record<string,unknown>={results:[entry('i1','AAPL'),entry('i2','NVDA')]};
 const f=await mirrorFixture(()=>page);
 try{
  expect((await f.lists.lists()).map(l=>l.name)).toEqual(['Mine','Popular']);
  expect(await f.lists.syncItems(f.mine)).toEqual({state:'synced',syncedAt:new Date(now).toISOString()});
  expect(f.state.reads.slice(1)).toEqual([{list_id:'custom-1'}]);
  expect((await f.lists.items(f.mine)).items.map(i=>i.kind==='market'&&i.symbol)).toEqual(['AAPL','NVDA']);
  page={results:[entry('i3','MSFT')],has_more:true};
  expect(await f.lists.syncItems(f.mine,true)).toMatchObject({state:'synced',partial:true});
  expect((await f.lists.items(f.mine)).items.map(i=>i.kind==='market'&&i.symbol).sort()).toEqual(['AAPL','MSFT','NVDA']);
 }finally{await f.db.close();}
});

test('edits to a custom Robinhood list write through first; curated lists and other venues do not',async()=>{
 const f=await mirrorFixture(()=>({results:[entry('i1','AAPL')]}));
 try{
  await f.lists.syncItems(f.mine);
  const aapl=(await f.lists.items(f.mine)).items[0];
  // Adding a Robinhood stock adds it on Robinhood, then marks the list for a re-read that adopts it.
  await f.lists.addItem(f.mine,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'x',kind:'stock'},symbol:'brk-b'}});
  expect(f.state.writes).toEqual([['add_to_watchlist',{list_id:'custom-1',symbols:['BRK.B']}]]);
  expect(await f.lists.items(f.mine)).toMatchObject({itemsStale:true});
  // Coinbase markets and takes stay local.
  await f.lists.addItem(f.mine,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'ETH-USD',kind:'crypto'},symbol:'ETH-USD'}});
  expect(f.state.writes).toHaveLength(1);
  // Removing a mirrored entry removes it on Robinhood.
  await f.lists.removeItem(f.mine,aapl.id);
  expect(f.state.writes[1]).toEqual(['remove_from_watchlist',{list_id:'custom-1',symbols:['AAPL']}]);
  expect((await f.lists.items(f.mine)).items.map(i=>i.kind==='market'&&i.symbol)).toEqual(['BRK.B','ETH-USD']);
  // A refused write changes nothing locally.
  f.state.refuse=true;
  await expect(f.lists.addItem(f.mine,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'x',kind:'equity'},symbol:'TSLA'}})).rejects.toThrow('refused');
  expect((await f.lists.items(f.mine)).total).toBe(2);
  f.state.refuse=false;f.state.connected=false;
  await expect(f.lists.addItem(f.mine,{kind:'market',market:{identity:{venue:'robinhood',instance:'production',reference:'x',kind:'equity'},symbol:'TSLA'}})).rejects.toThrow('Reconnect Robinhood to edit this list');
  // Robinhood's own lists are read-only, here as there.
  await expect(f.lists.addItem(f.popular,{kind:'market',market:{identity:{venue:'coinbase',instance:'production',reference:'ETH-USD',kind:'crypto'},symbol:'ETH-USD'}})).rejects.toThrow('read-only');
  expect(f.state.writes).toHaveLength(2);
 }finally{await f.db.close();}
});

test('agents read lists through a read-only tool',async()=>{
 const f=await mirrorFixture(()=>({results:[entry('i1','AAPL')]}));
 try{
  expect(toolCatalog().find(t=>t.name==='opentake_read_watchlists')?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
  const call=(input:unknown)=>callOpentakeTool({watchlists:input=>f.lists.agentRead(input),status:async()=>{throw Error();},read:async()=>{throw Error();}},'opentake_read_watchlists',input);
  const all=JSON.parse((await call({})).content[0].text as string);
  expect(all.lists.map((l:{name:string})=>l.name)).toEqual(['Mine','Popular']);
  // Opening a stale mirrored list reads it from Robinhood first.
  const one=JSON.parse((await call({listId:f.mine})).content[0].text as string);
  expect(one).toMatchObject({listId:f.mine,total:1,itemsStale:false,items:[{symbol:'AAPL',venue:'robinhood'}]});
  expect((await call({listId:f.mine,symbols:['TSLA']})).isError).toBe(true);
  expect(f.state.writes).toEqual([]);
 }finally{await f.db.close();}
});

test('Robinhood crypto on a list is priced from get_crypto_quotes by pair id, cached briefly',async()=>{
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let clock=now,connected=true,fail=false;
 const calls:string[][]=[];
 const lists=createWatchlists(database as never,{robinhoodQuotesReady:async()=>false,coinbaseDetail:async id=>coinbase(id),now:()=>clock,
  robinhoodCryptoQuotes:async symbols=>{
   calls.push(symbols);
   if(fail)throw Error('offline');
   if(!connected)return null;
   // A row for another pair under a requested symbol is not this pair's price.
   return {data:{results:[{id:'pair-btc',symbol:'BTCUSD',mark_price:'66000.500000',updated_at:new Date(clock-5_000).toISOString(),open_price:'60000'},
    {id:'someone-else',symbol:'ETHUSD',mark_price:'1',updated_at:new Date(clock).toISOString()}]}};
  }});
 try{
  const list=await lists.create({name:'Crypto'});
  const pair=(reference:string,symbol:string)=>({kind:'market' as const,market:{identity:{venue:'robinhood',instance:'production',reference,kind:'crypto'},symbol}});
  await lists.addItem(list.id,pair('pair-btc','BTC'));
  await lists.addItem(list.id,pair('pair-eth','ETH-USD'));
  const priced=async()=>(await lists.items(list.id)).items.map(i=>i.kind==='market'?[i.symbol,i.quote?.price??i.quoteGap,i.quote?.changePercent??null]:null);
  expect(await priced()).toEqual([['BTC','66000.5','10.00'],['ETH-USD','unavailable',null]]);
  expect(calls).toEqual([['BTC-USD','ETH-USD']]);
  // Within the cache window nothing is read again.
  await priced();
  expect(calls).toHaveLength(1);
  clock+=31_000;connected=false;
  expect(await priced()).toEqual([['BTC','connect',null],['ETH-USD','connect',null]]);
  clock+=31_000;connected=true;fail=true;
  expect(await priced()).toEqual([['BTC','unavailable',null],['ETH-USD','unavailable',null]]);
 }finally{await db.close();}
});

test('lists and app items reorder; mirrored entries keep Robinhood’s order',async()=>{
 const f=await mirrorFixture(()=>({results:[entry('i1','AAPL'),entry('i2','NVDA')]}));
 try{
  const a=await f.lists.create({name:'A'}),b=await f.lists.create({name:'B'});
  const names=async()=>(await f.lists.lists()).map(l=>l.name);
  expect(await names()).toEqual(['Mine','Popular','A','B']);
  await f.lists.move(b.id,0);
  expect(await names()).toEqual(['B','Mine','Popular','A']);
  await f.lists.move(b.id,99);
  expect(await names()).toEqual(['Mine','Popular','A','B']);
  // A Robinhood sync keeps the member's order.
  await f.lists.sync(true);
  expect(await names()).toEqual(['Mine','Popular','A','B']);

  const coin=(id:string)=>({kind:'market' as const,market:{identity:{venue:'coinbase',instance:'production',reference:id,kind:'crypto'},symbol:id}});
  for(const id of ['BTC-USD','ETH-USD','SOL-USD'])await f.lists.addItem(a.id,coin(id));
  const symbols=async(id:string)=>(await f.lists.items(id)).items.map(i=>i.kind==='market'?i.symbol:i.title);
  const [,,sol]=(await f.lists.items(a.id)).items;
  await f.lists.moveItem(a.id,sol.id,0);
  expect(await symbols(a.id)).toEqual(['SOL-USD','BTC-USD','ETH-USD']);

  // On a mirrored list app items move only after Robinhood's entries.
  await f.lists.syncItems(f.mine);
  await f.lists.addItem(f.mine,coin('BTC-USD'));
  await f.lists.addItem(f.mine,coin('ETH-USD'));
  expect(await symbols(f.mine)).toEqual(['AAPL','NVDA','BTC-USD','ETH-USD']);
  const mine=(await f.lists.items(f.mine)).items;
  await f.lists.moveItem(f.mine,mine[3].id,0);
  expect(await symbols(f.mine)).toEqual(['AAPL','NVDA','ETH-USD','BTC-USD']);
  await expect(f.lists.moveItem(f.mine,mine[0].id,3)).rejects.toThrow('Robinhood sets the order');
  await expect(f.lists.moveItem(f.popular,mine[0].id,0)).rejects.toThrow('read-only');
 }finally{await f.db.close();}
});
