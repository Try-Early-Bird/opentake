import {test,expect} from 'vitest';
import {logCalls,callLevel} from '../../src/shared/log-calls';
import type {DiagnosticRow} from '../../src/shared/diagnostics';
const row=(event:string,time:string,source='host'):DiagnosticRow=>({event,time,source,details:{callId:'a'},venue:'coinbase'});
test('pairs newest-first events before pagination and preserves failure severity',()=>{
 const response=row('broker.failed','2026-10-14T10:00:01Z'),request=row('broker.called','2026-10-14T10:00:00Z');
 const calls=logCalls([response,request]);expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({request,response});expect(callLevel(calls[0])).toBe('error');
});
test('does not pair distinct processes and retains orphan requests and responses',()=>{
 const calls=logCalls([row('broker.called','2026-10-14T10:00:00Z'),row('broker.returned','2026-10-14T10:00:01Z','desktop')]);
 expect(calls).toHaveLength(2);expect(calls[0].request).toBeUndefined();expect(calls[1].response).toBeUndefined();
});
test('nonbroker events remain individual even with shared correlation IDs',()=>{expect(logCalls([row('background.complete','a'),row('background.complete','b')])).toHaveLength(2);});
