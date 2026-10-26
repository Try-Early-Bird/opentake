import {expect,test} from 'vitest';
import {hasPendingInvestment,pendingInvestmentReason} from '../../src/shared/investment-status';
test('queued and open instructions suppress a missing-holding retry even alongside an older failure',()=>{
 expect(hasPendingInvestment([{status:'pending'}])).toBe(true);
 expect(hasPendingInvestment([{status:'failed'},{status:'open'}])).toBe(true);
 for(const status of ['failed','settled','cancelled','superseded'])expect(hasPendingInvestment([{status}])).toBe(false);
 expect(hasPendingInvestment([])).toBe(false);
});
test('mixed reservations wait for market open and are preparing when the market is open',()=>{
 expect(pendingInvestmentReason('mixed_funded',true)).toBe('market_closed');
 expect(pendingInvestmentReason('mixed_funded',false)).toBe('requested');
 expect(pendingInvestmentReason('retry_required',true)).toBe('retry_required');
 expect(pendingInvestmentReason(null,true)).toBeNull();
});
