import {expect,test} from 'vitest';
import {assetAmount,assetQuantity,money} from '../../src/renderer/src/portfolio/format';

test('asset amounts follow formatShares tiers; cash-like units read like money',()=>{
 expect(assetAmount('82.932326754342587813','USDC')).toBe('82.93 USDC');
 expect(assetAmount('1234.5','usdc')).toBe('1,234.50 USDC');
 expect(assetAmount('1234.567891234','SOL')).toBe('1.2K SOL');
 expect(assetAmount('12.3456','SOL')).toBe('12.35 SOL');
 expect(assetAmount('0.123456','ETH')).toBe('0.1235 ETH');
 expect(assetAmount('0.05','ETH')).toBe('0.05 ETH');
 expect(assetAmount('0.001234567891','BTC')).toBe('0.00123457 BTC');
 expect(assetAmount('0.00000001','BTC')).toBe('0.00000001 BTC');
 expect(assetAmount('0','ETH')).toBe('0 ETH');
 expect(assetAmount('-0.5','ETH')).toBe('-0.50 ETH');
 expect(assetAmount('n/a','BTC')).toBe('n/a BTC');
});

test('money reads a non-ISO unit such as USDC as an amount of it instead of throwing',()=>{
 expect(money('82.932326754342587813','USDC')).toBe('82.93 USDC');
 expect(money('1234.5','USD')).toBe('$1,234.50');
 expect(assetQuantity('0.001234567891')).toBe('0.00123457');
 expect(assetQuantity('82.9323','USDC')).toBe('82.93');
});
