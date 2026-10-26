import {createServer} from 'vite';import react from '@vitejs/plugin-react';import {chromium} from 'playwright-core';import assert from 'node:assert/strict';
const server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0}});let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/coinbase-live-price/index.html');
 await page.getByText('2345.67',{exact:true}).waitFor();
 await page.evaluate(()=>window.__liveFixture.stale=true);await page.getByText('Fetched price',{exact:true}).waitFor();
 await page.evaluate(()=>window.__liveFixture.stale=false);await page.getByText('2345.67',{exact:true}).waitFor();
 await page.evaluate(()=>window.__liveFixture.retrying=true);await page.getByText('Fetched price',{exact:true}).waitFor();
 await page.evaluate(()=>window.__liveFixture.retrying=false);
 await page.getByRole('button',{name:'Switch product'}).click();await page.getByText('98765.43',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Leave'}).click();
 await page.waitForFunction(()=>window.__liveFixture.events.includes('release:BTC-USD'));
 assert.deepEqual(await page.evaluate(()=>window.__liveFixture.events),['acquire:ETH-USD','release:ETH-USD','acquire:BTC-USD','release:BTC-USD']);
 assert.deepEqual(errors,[]);console.log('Live price, stale/disconnected fallback, recovery, product switch and unmount release passed.');
}finally{await browser?.close();await server.close();}
