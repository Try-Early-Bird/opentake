import {test,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RebalanceStatus} from '../../src/renderer/src/strategies/RebalanceStatus';
import type {CoinbaseLifecycle} from '../../src/shared/coinbase-lifecycle';
const view={driftEnabled:true,pending:false,currentRules:{driftBandPoints:1,driftBandRelative:null},rebalanceWarning:{code:'insufficient_funds',checkedAt:'2026-10-13T21:10:00Z',nextRetryAt:'2026-10-13T21:15:00Z',cash:{currency:'USDC',required:'2.47185332',available:'2.46060376',shortfall:'0.01124956'}}} as CoinbaseLifecycle;
test('rebalance status uses actual rules and compact cash amounts',()=>{
 const html=renderToStaticMarkup(createElement(RebalanceStatus,{view,busy:false,onToggle:()=>{},onRefresh:()=>{}}));
 expect(html).toContain('Triggers at 1 pt');expect(html).toContain('Waiting on cash');expect(html).toContain('2.47');expect(html).toContain('2.46');expect(html).not.toContain('2.47185332');expect(html).toContain('Refresh rebalance status');expect(html).not.toContain('rounded-lg border');
});
test('paused status hides the old warning and offers enable',()=>{
 const html=renderToStaticMarkup(createElement(RebalanceStatus,{view:{...view,driftEnabled:false},busy:false,onToggle:()=>{},onRefresh:()=>{}}));
 expect(html).toContain('Paused');expect(html).toContain('Enable');expect(html).not.toContain('Waiting on cash');
});
