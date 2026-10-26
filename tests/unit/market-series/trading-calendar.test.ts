import {expect,test} from 'vitest';
import {isRegularSessionOpen,nextRegularSessionOpen,regularSessionMinutesBetween,easternWallTimeToUtc,isMarketHoliday} from '../../../src/main/market-series/sessions';
import {newestSettledTradingDay} from '../../../src/main/market-series/price-store';
test('NYSE early closes bound execution, stale-leg time and settled closes',()=>{
 const before=easternWallTimeToUtc('2026-11-27',12*60+59),close=easternWallTimeToUtc('2026-11-27',13*60);
 expect(isRegularSessionOpen(before)).toBe(true);expect(isRegularSessionOpen(close)).toBe(false);
 expect(nextRegularSessionOpen(close)).toBe(easternWallTimeToUtc('2026-11-30',570));
 expect(regularSessionMinutesBetween(easternWallTimeToUtc('2026-11-27',12*60),easternWallTimeToUtc('2026-11-27',16*60))).toBe(60);
 expect(newestSettledTradingDay(close)).toBe('2026-11-27');
});
test('2028 published holidays and early closes are covered; trading refuses an expired calendar',()=>{
 expect(isMarketHoliday('2028-04-14')).toBe(true);
 expect(isRegularSessionOpen(easternWallTimeToUtc('2028-07-03',13*60))).toBe(false);
 expect(()=>isRegularSessionOpen(easternWallTimeToUtc('2029-01-02',600))).toThrow('calendar expired');
});
