import type {TakeOrderWriter} from '../execution/executor';
import type {createDatabaseLifecycle} from '../database';
/** Route by explicit request identity and then the durable intent's asset class.
 * Never infer crypto from a ticker, account or currently selected screen. */
export function createTakeOrderWriter(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,writers:{equity:TakeOrderWriter;crypto:TakeOrderWriter}):TakeOrderWriter {
 return {
  review(input){
   const crypto=typeof input.order==='object'&&input.order!==null&&Object.hasOwn(input.order,'currency_pair_id');
   return (crypto?writers.crypto:writers.equity).review(input);
  },
  async confirm(id){
   const row=(await database.use(db=>db.query<{asset_class:string}>('SELECT asset_class FROM order_intents WHERE id=$1',[id]))).rows[0];
   if(!row||!['equity','crypto'].includes(row.asset_class))throw Error('Take order intent not found');
   return (row.asset_class==='crypto'?writers.crypto:writers.equity).confirm(id);
  },
 };
}
