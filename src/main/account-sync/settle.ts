/** Reconcile immutable evidence already persisted, even when another resource failed. */
export async function synchronizeAndSettle(sync:()=>Promise<void>,settle:()=>Promise<void>):Promise<void>{
 let failed=false,error:unknown;
 try{await sync();}catch(cause){failed=true;error=cause;}
 await settle();
 if(failed)throw error;
}
