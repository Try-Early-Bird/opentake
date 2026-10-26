import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { documentLimits } from '../shared/chat-documents';
export type PdfResult={pages?:string[];image?:string};
export type PdfProcessor=(data:Uint8Array,page?:number,signal?:AbortSignal)=>Promise<PdfResult>;

// Bound CPU/memory concurrency. Parsing happens off the host event loop and can
// be terminated even when a malformed document stalls its parser. Page renders
// run in their own lane so a tool call never waits behind another take's
// full-document indexing, and a caller that gives up stops waiting at once.
function lane(){
 let tail:Promise<unknown>=Promise.resolve();
 return <T>(task:()=>Promise<T>,signal?:AbortSignal):Promise<T>=>{
  const job=tail.catch(()=>{}).then(()=>{signal?.throwIfAborted();return task();});
  tail=job;
  if(!signal)return job;
  return new Promise<T>((resolve,reject)=>{
   const abort=()=>reject(new Error('PDF processing cancelled.'));
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
   job.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
 };
}
const indexing=lane(),rendering=lane();
export const processPdf:PdfProcessor=(data,page,signal)=>(page===undefined?indexing:rendering)(()=>new Promise<PdfResult>((resolve,reject)=>{
 const worker=new Worker(join(__dirname,'pdf-worker.js'),{workerData:{data,page},transferList:[data.buffer as ArrayBuffer]});
 let done=false;
 const finish=(error?:Error,result?:PdfResult)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!);};
 const abort=()=>finish(new Error('PDF processing cancelled.'));
 const timer=setTimeout(()=>finish(new Error('PDF processing timed out. Try a less complex document.')),documentLimits.timeoutMs);
 signal?.addEventListener('abort',abort,{once:true});
 worker.once('message',result=>finish(result.error?new Error(result.error):undefined,result));
 worker.once('error',()=>finish(new Error('PDF processing failed.')));
 worker.once('exit',()=>{if(!done)finish(new Error('PDF processing stopped unexpectedly.'));});
}),signal);
