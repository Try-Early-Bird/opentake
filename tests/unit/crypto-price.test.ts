import {expect,test} from 'vitest';
import {cryptoPrice,cryptoVolume} from '../../src/renderer/src/crypto-price';
test('formats exact quote units and preserves sub-cent crypto prices',()=>{
 expect(cryptoPrice('500','USDC')).toBe('500.00 USDC');expect(cryptoPrice('500','USD')).toBe('$500.00');expect(cryptoPrice('0.00000012','USD')).toBe('$0.00000012');expect(cryptoPrice('0.0001','BTC')).toBe('0.0001 BTC');expect(cryptoPrice('NaN','USD')).toBe('—');
});

test('compacts quote volume while keeping USD and USDC distinct',()=>{
 expect(cryptoVolume('114200000','USD')).toBe('$114.20M');
 expect(cryptoVolume('114200000','USDC')).toBe('114.20M USDC');
});
