import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,test,vi} from 'vitest';
vi.stubGlobal('React',React);
vi.mock('@tanstack/react-router',()=>({Link:({to,params,children,...props}:any)=>React.createElement('a',{...props,href:to.replace('$market',encodeURIComponent(params?.market??'')).replace('$symbol',params?.symbol??'').replace('$product',params?.product??'')},children)}));
import {StrategyHoldingsList} from '../../../src/renderer/src/strategies/StrategyCard';
import type {StrategyCardData} from '../../../src/renderer/src/strategies/preview-data';
test('same-ticker crypto displays separately and navigates by provider identity without a stock price',()=>{
 const market={venue:'robinhood',instance:'production',reference:'synthetic-btc-pair',kind:'crypto'};
 const strategy:StrategyCardData={id:'synthetic',displayName:'Synthetic',description:null,iconUrl:null,author:{name:'You',handle:null,earlybirdHandle:null},targets:{complete:true,cashReserveBps:0,weights:[{venue:'robinhood',symbol:'BTC',weightBps:5000},{venue:'robinhood',symbol:'BTC',market,weightBps:5000,currentPrice:'999',previousClose:'1'}]},stats:[],version:{number:1}};
 const html=renderToStaticMarkup(React.createElement(StrategyHoldingsList,{strategy}));
 expect(html).toContain('href="/rh/BTC"');
 expect(html).toContain('href="/markets/');
 expect(decodeURIComponent(html.match(/href="(\/markets\/[^"]+)"/)![1])).toContain('synthetic-btc-pair');
 expect(html).toContain('Crypto');
 expect(html).not.toContain('99,800');
 expect(html.match(/50%/g)).toHaveLength(2);
});


test('draft market actions preserve stock, crypto pair and Coinbase destinations',async()=>{
 const {InstrumentMarketLink}=await import('../../../src/renderer/src/strategies/InstrumentMarketLink');
 const stock=renderToStaticMarkup(React.createElement(InstrumentMarketLink,{instrument:{venue:'robinhood',symbol:'BTC'}}));
 const crypto=renderToStaticMarkup(React.createElement(InstrumentMarketLink,{instrument:{venue:'robinhood',symbol:'BTC',market:{venue:'robinhood',instance:'production',reference:'exact-pair',kind:'crypto'}}}));
 const coinbase=renderToStaticMarkup(React.createElement(InstrumentMarketLink,{instrument:{venue:'coinbase',symbol:'BTC-EUR'}}));
 expect(stock).toContain('href="/rh/BTC"');
 expect(crypto).toContain('href="/markets/');expect(decodeURIComponent(crypto)).toContain('exact-pair');
 expect(coinbase).toContain('href="/coinbase/BTC-EUR"');
 expect(stock).toContain('aria-label="Open BTC market on Robinhood"');
 expect(crypto).toContain('aria-label="Open BTC crypto market on Robinhood"');
});
