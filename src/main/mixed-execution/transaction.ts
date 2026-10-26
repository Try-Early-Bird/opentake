import type { Transaction } from '@electric-sql/pglite';
import type { DatabaseClient as PGlite } from '../database-client';
import type {createDatabaseLifecycle} from '../database';
/** Reuse venue ledger services inside the parent's transaction, without nested
 * transactions or acquiring another lifecycle handle. Never pass to network code. */
export function transactionDatabase(tx:Transaction):Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>{
 const scoped=new Proxy(tx,{get(target,key){if(key==='transaction')return async<T>(work:(value:Transaction)=>Promise<T>)=>work(tx);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as PGlite;
 return {use:async work=>work(scoped)};
}
