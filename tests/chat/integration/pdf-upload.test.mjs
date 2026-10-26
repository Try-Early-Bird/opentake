import { closeDesktop } from '../../helpers/desktop.mjs';
import { dismissConnectionPrompt } from '../../helpers/onboarding.mjs';
import { stopHost } from '../../helpers/host.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import executablePath from 'electron';
import sharp from 'sharp';

// Minimal synthetic PDF with proper offsets, embedded page content and no external data.
function pdf(pages) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const kids=[];
 for(const text of pages){
  const pageId=objects.length+1,streamId=pageId+1;kids.push(`${pageId} 0 R`);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
  const stream=`0.1 0.4 0.8 rg 40 40 120 160 re f\n${text?`BT /F1 18 Tf 30 340 Td (${text}) Tj ET`:''}`;
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
 let body='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(body);
 body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(body);
}

test('PDF documents retain long files, preview pages, support text models and reject invalid inputs',{timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-pdf-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();page.setDefaultTimeout(12000);await page.setViewportSize({width:1440,height:1000});
  await dismissConnectionPrompt(page,app);
  await app.evaluate(({ipcMain})=>{
   ipcMain.removeHandler('chat:models');
   ipcMain.handle('chat:models',()=>({ok:true,source:'runtime',models:[{value:'default',label:'Synthetic vision',imageInput:true},{value:'text',label:'Synthetic text',imageInput:false}]}));
  });
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('link',{name:'Opentake home',exact:true}).click();
  await page.getByRole('button',{name:'Choose AI model'}).getByText('Synthetic vision').waitFor();
  const input=page.locator('input[type=file]').first(),composer=page.getByRole('textbox',{name:/Message /});
  const original=pdf(Array.from({length:40},(_,n)=>`Report page ${n+1}`));
  await composer.fill('Summarize this report');
  await input.setInputFiles({name:'report.pdf',mimeType:'application/pdf',buffer:original});
  await page.getByRole('button',{name:'Preview report.pdf',exact:true}).waitFor();
  assert.equal(await composer.inputValue(),'Summarize this report');
  const draft=await page.evaluate(async()=>{const state=await window.takes.snapshot(null,false);return state.takes[0].id;});
  const saved=await page.evaluate(async id=>(await window.takes.snapshot(id,false)).take,draft);
  assert.equal(saved.draftDocuments[0].pages,40);assert.equal(saved.draftDocuments[0].bytes,original.length);assert.equal(saved.draftImages.length,0);
  await page.evaluate(id=>window.takes.update(id,{title:'PDF fixture'}),draft);
  await page.getByRole('button',{name:'Preview report.pdf',exact:true}).click();
  await page.getByRole('dialog',{name:'report.pdf',exact:true}).waitFor();
  await page.getByRole('spinbutton',{name:'PDF page'}).fill('40');
  await page.getByText('Report page 40',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Show page image',exact:true}).click();
  const preview=page.getByRole('img',{name:'report.pdf, page 40',exact:true});await preview.waitFor();
  const pixels=await sharp(Buffer.from((await preview.getAttribute('src')).split(',')[1],'base64')).raw().toBuffer({resolveWithObject:true});
  assert.ok(pixels.info.width>=600);
  assert.ok(pixels.data.some((value,index)=>index%3===2&&value>150&&pixels.data[index-2]<80),'Rendered page includes the blue chart');
  await page.screenshot({path:process.env.PDF_TEST_SCREENSHOT??join(profile,'pdf-preview.png')});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('link',{name:'Opentake home',exact:true}).click();
  await page.getByRole('button',{name:'PDF fixture',exact:true}).click();
  await page.getByRole('button',{name:'Preview report.pdf',exact:true}).waitFor();
  await page.getByRole('button',{name:'New Take',exact:true}).click();
  await page.getByRole('button',{name:'Choose AI model'}).click();await page.getByRole('menuitemradio',{name:'Synthetic text',exact:true}).click();
  await input.setInputFiles({name:'text.pdf',mimeType:'application/pdf',buffer:pdf(['Readable PDF'])});
  await page.getByRole('button',{name:'Preview text.pdf',exact:true}).waitFor();
  assert.equal(await composer.inputValue(),'');
  await input.setInputFiles({name:'scan.pdf',mimeType:'application/pdf',buffer:pdf([''])});
  await page.getByRole('button',{name:'Preview scan.pdf',exact:true}).waitFor();
  await page.getByText(/1 scanned page/).waitFor();
  await input.setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('bad bytes')});
  await page.getByText('This file is not a valid PDF.',{exact:true}).waitFor();assert.equal(await composer.inputValue(),'');

 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
