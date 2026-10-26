import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from '../../helpers/onboarding.mjs';
import {stopHost} from '../../helpers/host.mjs';

test('MCP metadata source and revision changes are inspectable in Settings',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-metadata-ui-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  const id=await page.evaluate(()=>window.mcp.save(null,{name:'Research MCP',transport:'http',url:'https://example.test/mcp',command:'',args:[],env:{},bindings:[],oauth:false}));
  await app.evaluate(({ipcMain},id)=>{
   const revision={id:'7',source_id:id,observed_at:'2026-10-01T12:00:00Z',fingerprint:'new-fingerprint',previous_fingerprint:'old-fingerprint',summary:'Server guidance updated',snapshot:{serverName:'Research MCP',destination:'https://example.test/mcp',instructions:'Use example for research. <script>synthetic text only</script>',tools:[{name:'example',description:'Research a topic',inputSchema:{type:'object'}}]}};
   for(const channel of ['mcp:metadata-history','mcp:metadata-revision'])ipcMain.removeHandler(channel);
   ipcMain.handle('mcp:metadata-history',()=>({items:[revision],next:null}));ipcMain.handle('mcp:metadata-revision',()=>revision);
  },id);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'MCP servers & tools',exact:true}).click();
  await page.getByRole('button',{name:'Guidance & changes',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:/Revision 7/}).click();await dialog.getByText('Provided by Research MCP · https://example.test/mcp',{exact:true}).waitFor();
  assert.match(await dialog.locator('pre').first().innerText(),/<script>synthetic text only<\/script>/);
  await dialog.locator('summary').filter({hasText:'Revision fingerprints'}).click();await dialog.getByText(/Previous: old-fingerprint/).waitFor();
  await page.keyboard.press('Escape');

 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
