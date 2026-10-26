import { closeDesktop } from '../../helpers/desktop.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import sharp from 'sharp';
import {_electron as electron} from 'playwright-core';
import executablePath from 'electron';
import {dismissConnectionPrompt} from '../../helpers/onboarding.mjs';
import {stopHost} from '../../helpers/host.mjs';

test('Electron normalizes screenshots and previews saved references without provider credentials',{timeout:40000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'opentake-images-'));let app;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  app=await electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:900});page.setDefaultTimeout(7000);await dismissConnectionPrompt(page,app);
  const source=await sharp({create:{width:40,height:20,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const result=await page.evaluate(async encoded=>{const id=await window.takes.create();const image=await window.takes.upload(id,'Screenshot.jpg',encoded);await window.takes.update(id,{title:'Image fixture',draftImages:[image.id]});return {image,url:await window.takes.image(image.id)};},source.toString('base64'));
  assert.equal(result.image.mime,'image/jpeg');assert.equal(result.image.width,20);assert.equal(result.image.height,40);assert.match(result.url,/^data:image\/jpeg;base64,/);
  const stored=await sharp(Buffer.from(result.url.split(',')[1],'base64')).metadata();assert.equal(stored.orientation,undefined);assert.equal(stored.exif,undefined);
  await page.getByRole('button',{name:'Image fixture',exact:true}).click();
  await page.getByRole('button',{name:'Preview Screenshot.jpg',exact:true}).click();await page.getByRole('dialog',{name:'Screenshot.jpg',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Attach files',exact:true}).getAttribute('title'),'Attach PDFs or text files');
  await page.getByRole('button',{name:'Remove Screenshot.jpg',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Preview Screenshot.jpg',exact:true}).count(),0);
 }finally{if(app)await closeDesktop(app);await stopHost(profile);await rm(profile,{recursive:true,force:true});}
});
