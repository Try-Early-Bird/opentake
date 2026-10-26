import {test,expect} from 'vitest';
import {cryptoOrderNumber} from '../../../src/shared/crypto-order-input';
test('accepts grouped prices without changing decimal precision or treating decimal commas as thousands',()=>{
 expect(cryptoOrderNumber('90,000')).toBe('90000');expect(cryptoOrderNumber(' 90,000.123456789012345678 ')).toBe('90000.123456789012345678');expect(cryptoOrderNumber('5')).toBe('5');
 for(const value of ['90,00','5,50','1,000,00','1e5','$5','-5',''])expect(()=>cryptoOrderNumber(value)).toThrow();
});
