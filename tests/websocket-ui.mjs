import {createServer} from 'vite';import react from '@vitejs/plugin-react';import tailwindcss from '@tailwindcss/vite';import {chromium} from 'playwright-core';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';
const server=await createServer({configFile:false,plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:0},resolve:{dedupe:['react','react-dom']}});let browser;
try{
 await mkdir('.local/designs/plan16d',{recursive:true});await server.listen();browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:1360,height:1000},colorScheme:'light'});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/data-sources-ui/index.html');await page.getByRole('button',{name:'Add source',exact:true}).click();
 await page.getByRole('combobox',{name:'Source type'}).click();await page.getByRole('option',{name:'WebSocket',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Price stream');await page.getByLabel('Endpoint',{exact:true}).fill('wss://fixture.example/prices');await page.getByRole('button',{name:'Connect & inspect'}).click();
 await page.getByText('plain text message',{exact:true}).waitFor();await page.getByRole('button',{name:'Use string payload'}).click();await page.getByRole('button',{name:'Collection & storage',exact:true}).last().click();await page.getByRole('button',{name:'Review source'}).click();await page.getByRole('button',{name:'Save & validate'}).click();await page.getByRole('button',{name:'Enable source',exact:true}).click();
 const region=page.getByRole('region',{name:'WebSocket source details'});
 await region.getByText('Market open — streaming BTC-USD prices',{exact:true}).waitFor();await region.getByText('{"price":"123.45"}',{exact:true}).waitFor();
 await page.screenshot({path:'.local/designs/plan16d/implemented-websocket.png'});
 await region.getByRole('button',{name:'Parsed',exact:true}).click();assert.match(await region.getByText(/"price": "123.45"/).textContent(),/\n/);
 await region.getByRole('button',{name:'Raw',exact:true}).click();await region.getByText('{"price":"123.45"}',{exact:true}).click();await page.getByRole('dialog').getByText('Message payload',{exact:true}).waitFor();await page.keyboard.press('Escape');
 await region.getByRole('button',{name:'Pause',exact:true}).click();await region.getByRole('button',{name:'Resume',exact:true}).waitFor();await region.getByRole('button',{name:'Clear',exact:true}).click();assert.equal(await region.getByText('Market open — streaming BTC-USD prices',{exact:true}).count(),0);await region.getByRole('button',{name:'Resume',exact:true}).click();
 await region.getByRole('button',{name:'Always',exact:true}).click();await region.getByText('Stays open while the app’s background host is running').waitFor();await region.getByRole('button',{name:'History',exact:true}).click();await region.getByText('History sampling',{exact:true}).waitFor();
 const state=await page.evaluate(()=>window.__fixture);assert.equal(state.wsSaved[0].config.collection,'automatic');assert.equal(state.wsSaved[0].config.feeds[0].storage.mode,'history');assert.equal(state.wsSaved[0].config.feeds[0].mapping.kind,'text');
 await region.getByRole('switch',{name:'Live connection'}).click();await page.waitForFunction(()=>window.__fixture.wsSaved[0].enabled===false);

 await page.getByRole('button',{name:'Add source',exact:true}).click();await page.getByRole('combobox',{name:'Source type'}).click();await page.getByRole('option',{name:'WebSocket',exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Structured stream');await page.getByLabel('Endpoint',{exact:true}).fill('wss://fixture.example/structured');
 await page.getByRole('combobox',{name:'Payload format'}).click();await page.getByRole('option',{name:'JSON fields',exact:true}).click();await page.getByRole('button',{name:'Connect & inspect'}).click();
 assert.equal(await page.getByRole('button',{name:'Use selected fields'}).isDisabled(),true);
 await page.getByRole('checkbox',{name:'Use price',exact:true}).check();await page.getByLabel('Unit',{exact:true}).fill('USD');
 await page.screenshot({path:'.local/designs/plan16d/websocket-sample-mapping.png'});
 await page.getByRole('button',{name:'Use selected fields'}).click();await page.getByRole('button',{name:'Collection & storage',exact:true}).last().click();await page.getByRole('button',{name:'Review source'}).click();await page.getByRole('button',{name:'Save & validate'}).click();await page.getByRole('button',{name:'Enable source',exact:true}).click();
 const structured=await page.evaluate(()=>window.__fixture.wsSaved.find(source=>source.config.name==='Structured stream'));
 assert.equal(structured.config.connection.dataMode,'json');assert.deepEqual(structured.config.feeds[0].mapping,{kind:'metric',valuePath:['price']});assert.equal(structured.config.feeds[0].unit,'USD');
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByRole('button',{name:'Connect & inspect'}).click();assert.equal(await page.getByRole('checkbox',{name:'Use price',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'Use symbol',exact:true}).isChecked(),false);await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('WebSocket setup, raw/parsed payloads, full payload, pause/clear, collection and history controls passed.');
}finally{await browser?.close();await server.close();}
