import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate,migrations} from '../../../src/main/migrations';
import {chooseFinancialRetention,getFinancialRetention} from '../../../src/main/allocations/retention';

test('account history keeps a year by default, and an untouched 90-day setting moves to a year',async()=>{
 const fresh=new PGlite();try{await migrate(fresh);expect(await getFinancialRetention(fresh)).toBe(366);}finally{await fresh.close();}
 // A profile from before pruning was scheduled: the stored 90 was never chosen by anyone.
 const upgraded=new PGlite();try{
  await migrate(upgraded,migrations.filter(m=>m.version<37));
  expect(await getFinancialRetention(upgraded)).toBe(90);
  await migrate(upgraded);
  expect(await getFinancialRetention(upgraded)).toBe(366);
 }finally{await upgraded.close();}
});

test('the Settings choices apply immediately; anything else is refused',async()=>{
 const db=new PGlite();try{
  await migrate(db);
  expect(await chooseFinancialRetention(db,90)).toBe(90);
  expect(await chooseFinancialRetention(db,null)).toBeNull();
  expect(await chooseFinancialRetention(db,366)).toBe(366);
  await expect(chooseFinancialRetention(db,7)).rejects.toThrow('Choose 90 days, 1 year or forever');
  expect(await getFinancialRetention(db)).toBe(366);
 }finally{await db.close();}
});
