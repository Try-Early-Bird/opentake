import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {readStoredMarketPrice} from '../../../src/main/data-sources/market-price-reader';
import {createCustomDataSources} from '../../../src/main/data-sources/service';
const equity={venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'};
const crypto={venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'};
test('stored broker quotes preserve precision, provenance, freshness and exact venue identity',async()=>{
 const db=new PGlite();try{
  await migrate(db);const now=Date.now();
  expect((await readStoredMarketPrice(db,equity,now)).quality).toBe('missing');
  await db.query('INSERT INTO market_quotes(symbol,price,observed_at,last_trade_at) VALUES($1,$2,$3,$3)',['AAPL','201.123456789123456789',new Date(now)]);
  expect(await readStoredMarketPrice(db,equity,now)).toMatchObject({quality:'fresh',quote:{payload:{kind:'quote',price:'201.123456789123456789'},provider:'robinhood',origin:'stored',timeBasis:'provider',currency:'USD'}});
  expect((await readStoredMarketPrice(db,equity,now+60000)).quality).toBe('stale');
  expect((await readStoredMarketPrice(db,equity,now-1)).quality).toBe('stale');
  for(const change of [{venue:'coinbase'},{instance:'sandbox'},{kind:'crypto'},{reference:'provider-uuid'},{pair:'AAPL-USD'}])expect((await readStoredMarketPrice(db,{...equity,...change},now)).quality).toBe('unsupported');
  await db.query("INSERT INTO public_price_cache VALUES('coinbase','BTC-USD','spot',86400,0,$1,$2,NULL)",[JSON.stringify({amount:'999',base:'BTC',currency:'USD'}),new Date(now)]);
  expect((await readStoredMarketPrice(db,crypto,now)).quality).toBe('missing');
  const data={id:'BTC-USD',venue:'coinbase',base:'BTC',quote:'USD',price:'123.000000000000000001'};
  await db.query("INSERT INTO public_price_cache VALUES('coinbase','BTC-USD','product',0,0,$1,$2,NULL)",[JSON.stringify(data),new Date(now)]);
  expect(await readStoredMarketPrice(db,crypto,now)).toMatchObject({quality:'fresh',quote:{payload:{price:data.price},provider:'coinbase',eventTime:null,timeBasis:'receipt'}});
  await db.query("UPDATE public_price_cache SET retry_at=$1 WHERE kind='product'",[new Date(now+60000)]);
  expect((await readStoredMarketPrice(db,crypto,now)).quality).toBe('stale');
  await db.query("UPDATE public_price_cache SET data=$1 WHERE kind='product'",[JSON.stringify({...data,quote:'EUR'})]);
  expect((await readStoredMarketPrice(db,crypto,now)).quality).toBe('invalid');
 }finally{await db.close();}
});
test('host cached-price reads never fetch and reject extra authority parameters',async()=>{
 const db=new PGlite();await migrate(db);const read=vi.fn(async()=>({}));
 const secrets={available:()=>false,get:async()=>{throw Error();},set:async()=>{throw Error();},delete:async()=>{throw Error();},has:async()=>false};
 const service=createCustomDataSources({use:work=>work(db)},secrets,{read});
 const call=(input:unknown)=>service.dispatch('dataSources:configure',[input],'11111111-1111-4111-8111-111111111111');
 try{expect(await call({action:'market-price',market:crypto})).toEqual({market:crypto,quality:'missing',quote:null});await expect(call({action:'market-price',market:crypto,endpoint:'https://fixture.example'})).rejects.toThrow();expect(read).not.toHaveBeenCalled();}finally{await service.close();await db.close();}
});
