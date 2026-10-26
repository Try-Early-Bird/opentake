import {expect,test} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PreflightSummary} from '../../src/renderer/src/strategies/PreflightSummary';
test('deposit preview shows the sized purchases and imbalance explanation',()=>{
 const html=renderToStaticMarkup(createElement(PreflightSummary,{currency:'USDC',preflight:{ok:true,kind:'contribution',amount:'5',legs:[{symbol:'BTC',notional:'1',weightPercent:50},{symbol:'ZEC',notional:'4',weightPercent:50}],allocationReason:'More goes to ZEC because it is below target weight.',retainedCash:'0',minimumAmount:'0',reasons:[],modelValuedOn:null,expectedValuedOn:null}}));
 expect(html).toContain('This buys');expect(html).toContain('1.00 USDC');expect(html).toContain('4.00 USDC');expect(html).toContain('More goes to ZEC');expect(html).not.toContain('50%');
});
