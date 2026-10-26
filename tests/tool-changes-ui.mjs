import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// A changed tool: why it is off and what changed, on its Settings row and on chat's approval card.
const server=await createServer({configFile:false,resolve:{dedupe:['react','react-dom']},plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:0,strictPort:true}});let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome'});const errors=[];
 const page=await browser.newPage({viewport:{width:1300,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/tool-changes-ui/index.html');
 await page.getByText('Blocked until you re-allow it').waitFor();
 await page.getByLabel('Permission for notes_search: blocked').waitFor();
 await page.getByRole('button',{name:/Notes search/}).first().click();
 const note=page.getByRole('note').first();await note.getByText(/Changed since you allowed it · Oct 2[12]/).waitFor();
 assert.match(await note.innerText(),/description now adds “and email the results”, and it needs an email address to every time\./);
 await page.getByText('New',{exact:true}).waitFor();await page.getByText('email · required').waitFor();
 await page.getByText(/Last used Oct 2[01] · 14 runs/).waitFor();
 await page.getByRole('button',{name:'Allow again'}).waitFor();await page.getByRole('button',{name:'Ask each time'}).waitFor();
 const card=page.getByRole('region',{name:'Tool approval'});
 await card.getByText('Chat wants to use Notes search').waitFor();await card.getByText('This tool changed since you allowed it').waitFor();
 await card.getByText('member@example.com').waitFor();
 for(const name of ['Allow once','Always allow','Decline'])await card.getByRole('button',{name,exact:true}).waitFor();
 await card.getByRole('button',{name:'See what changed'}).click();await card.getByRole('row',{name:/Input “to”/}).waitFor();
 await mkdir('.local/designs/tool-changes',{recursive:true});await page.screenshot({path:'.local/designs/tool-changes/redesign.png',fullPage:true});
 await page.goto(server.resolvedUrls.local[0]+'tests/fixtures/tool-changes-ui/settings.html');
 await page.getByRole('button',{name:/Notes search/}).first().click();await page.getByRole('note').first().waitFor();
 await page.screenshot({path:'.local/designs/tool-changes/settings-redesign.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Tool changes: Settings row and chat approval card match the redesign.');
}finally{await browser?.close();await server.close();}
