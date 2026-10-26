/** Serialize read-only previews, skipping superseded inputs and waiting out connection contention. */
export function createPreviewQueue(){
 let tail:Promise<unknown>=Promise.resolve();
 return function preview<T>(work:()=>Promise<T>,active:()=>boolean,onWaiting?:()=>void):Promise<T|undefined>{
  const next=tail.then(async()=>{
   const started=Date.now();
   for(let attempt=0;active();attempt++){
    try{return await work();}catch(error){
     if(!active())return;
     const message=error instanceof Error?error.message:String(error);
     if(!/Another Coinbase connection operation is running/i.test(message))throw error;
     const remaining=65000-(Date.now()-started);
     if(remaining<=0)throw Error('Coinbase is still busy with another operation. Your preview could not finish. Wait a moment, then retry preview.');
     onWaiting?.();
     await new Promise(resolve=>setTimeout(resolve,Math.min(250*2**Math.min(attempt,4),2000,remaining)));
    }
   }
  });
  tail=next.catch(()=>{});
  return next;
 };
}
