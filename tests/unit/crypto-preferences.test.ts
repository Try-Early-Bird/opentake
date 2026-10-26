import { expect, test } from 'vitest';
import { isCryptoDust, getHideCryptoDust, setHideCryptoDust } from '../../src/renderer/src/crypto-preferences';
test('hides dust by default, allows opting out, and keeps exact cutoff and unknown values visible',()=>{
 expect(getHideCryptoDust()).toBe(true);
 for(const amount of ['0','0.00','0.099999999999999999999'])expect(isCryptoDust(amount,'USD')).toBe(true);
 for(const amount of ['0.10','0.100000000000000001','1','1000'])expect(isCryptoDust(amount,'USD')).toBe(false);
 expect(isCryptoDust(null,'USD')).toBe(false);expect(isCryptoDust('unknown','USD')).toBe(false);expect(isCryptoDust('0.01','EUR')).toBe(false);
 setHideCryptoDust(false);expect(getHideCryptoDust()).toBe(false);
});

test('custom dust thresholds use exact decimals and reject invalid preferences',async()=>{
 const {getCryptoDustThreshold,setCryptoDustThreshold,normalizeDustThreshold}=await import('../../src/renderer/src/crypto-preferences');
 expect(getCryptoDustThreshold()).toBe('0.10');
 setCryptoDustThreshold('.25');expect(getCryptoDustThreshold()).toBe('0.25');
 expect(isCryptoDust('0.249999999999999999','USD','0.25')).toBe(true);
 expect(isCryptoDust('0.25','USD','0.25')).toBe(false);
 expect(isCryptoDust('9.99','USD','10')).toBe(true);
 expect(isCryptoDust('0','USD','0')).toBe(false);
 for(const value of ['', '-1','NaN','Infinity','1e3','0.001']){
  expect(normalizeDustThreshold(value)).toBeNull();expect(()=>setCryptoDustThreshold(value)).toThrow();
 }
 expect(getCryptoDustThreshold()).toBe('0.25');
});
