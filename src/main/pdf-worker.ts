import { parentPort,workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import { documentLimits } from '../shared/chat-documents';

async function processPdf(){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const root=dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'));
 const task=getDocument({data:workerData.data,verbosity:0,stopAtErrors:true,useSystemFonts:false,
  cMapUrl:join(root,'cmaps/'),cMapPacked:true,standardFontDataUrl:join(root,'standard_fonts/'),
  wasmUrl:join(root,'wasm/'),iccUrl:join(root,'iccs/')});
 try{
  const pdf=await task.promise;
  if(pdf.numPages>documentLimits.pages)throw new Error('PDF exceeds the 1,000-page processing limit.');
  if(workerData.page){
   const page=await pdf.getPage(workerData.page),size=page.getViewport({scale:1});
   const viewport=page.getViewport({scale:Math.min(2,1800/Math.max(size.width,size.height))});
   const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
   await page.render({canvas:canvas as unknown as HTMLCanvasElement,viewport,background:'#ffffff'}).promise;
   const bytes=await canvas.encode('jpeg',88);
   if(bytes.length>1024*1024)throw new Error('This page image is too large. Read its text instead.');
   parentPort!.postMessage({image:bytes.toString('base64')});
  }else{
   const pages:string[]=[];let characters=0;
   for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number),content=await page.getTextContent();
    const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('').replace(/\u0000/g,'').trim();
    characters+=text.length;
    if(characters>documentLimits.extractedCharacters)throw new Error('PDF exceeds the local text indexing limit. Split it into volumes.');
    pages.push(text);page.cleanup();
   }
   parentPort!.postMessage({pages});
  }
 }finally{await task.destroy();}
}
void processPdf().catch(error=>parentPort!.postMessage({error:error?.name==='PasswordException'?
 'Password-protected PDFs require an unlocked copy.':'Could not process this PDF. It may be damaged, too complex, or exceed the local processing limits.'}));
