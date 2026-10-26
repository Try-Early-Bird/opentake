import {expect,test} from 'vitest';
import {synchronizeAndSettle} from '../../src/main/account-sync/settle';
test('partial sync failure still settles captured fills and keeps the failed job retryable',async()=>{
 const events:string[]=[];const failure=new Error('option resource failed');
 await expect(synchronizeAndSettle(async()=>{events.push('equity persisted');throw failure;},async()=>{events.push('fills attributed');})).rejects.toBe(failure);
 expect(events).toEqual(['equity persisted','fills attributed']);
});
test('settlement failure propagates instead of marking the read job complete',async()=>{
 await expect(synchronizeAndSettle(async()=>{},async()=>{throw new Error('ledger unavailable');})).rejects.toThrow('ledger unavailable');
});
