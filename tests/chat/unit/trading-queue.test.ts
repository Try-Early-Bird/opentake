import {test,expect} from 'vitest';
import {readTradingQueue} from '../../../src/shared/trading-queue';
const item={id:'strategy:orders:synthetic:bucket',source:'strategy',state:'waiting',title:'Orders',detail:'Waiting for the open',reason:'market_closed',expectedAt:null,createdAt:'2026-10-05T15:00:00Z',link:{kind:'strategy',id:'synthetic'},actions:[]};
test('queue puts required approvals first and preserves executor actions',()=>{
 const rows=readTradingQueue([item,{...item,id:'active',state:'in_progress'},{...item,id:'approval',state:'needs_you',actions:['confirm','cancel'],approval:{summary:'Buy VTI',strategyName:'Synthetic'}}]);
 expect(rows.map(r=>r.id)).toEqual(['approval','active',item.id]);expect(rows[0].actions).toEqual(['confirm','cancel']);expect(rows[2].actions).toEqual([]);
});
test('malformed queue responses cannot become empty queues or invented actions',()=>{
 expect(()=>readTradingQueue([{...item,actions:['retry']}])).toThrow();expect(()=>readTradingQueue(null)).toThrow();expect(()=>readTradingQueue([{...item,state:'completed'}])).toThrow();
});
