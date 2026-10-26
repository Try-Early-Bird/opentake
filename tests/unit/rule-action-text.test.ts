// The rule review compares action text, so a changed trade amount must show in it.
import {expect,test} from 'vitest';
import {actionText} from '../../src/renderer/src/strategies/rule-action-text';

const scope={accountId:'00000000-0000-4000-8000-000000000001'};
test('trading actions show their amount, so an amount change is visible in a review',()=>{
 expect(actionText({kind:'reduce',scope,amount:{value:'2',currency:'USD'}} as never)).toBe('Reduce by $2 (money back to your account)');
 expect(actionText({kind:'reduce',scope,amount:{value:'2000',currency:'USD'}} as never)).toBe('Reduce by $2,000 (money back to your account)');
 expect(actionText({kind:'deploy_cash',scope,amount:{value:'25.50',currency:'USDC'}} as never)).toBe('Invest up to $25.50 USDC of the Take’s cash');
 expect(actionText({kind:'rebalance_to_target',scope} as never)).toBe('Rebalance to target');
});
