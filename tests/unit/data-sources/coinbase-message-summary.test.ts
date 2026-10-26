import {expect,test} from 'vitest';
import {coinbaseMessageSummary,messageTime,messageBytes} from '../../../src/renderer/src/data-sources/coinbase-message-summary';
const row=(frame:unknown)=>({id:1,type:'json' as const,receivedAt:0,bytes:269,text:JSON.stringify(frame)});
test('summarizes trades and heartbeats without changing the raw frame',()=>{
 const input=row({channel:'market_trades',events:[{trades:[{product_id:'BTC-USD',side:'BUY',size:'0.0021',price:'83489.561234',time:'2026-10-19T12:00:00Z'}]}]});
 expect(coinbaseMessageSummary(input)).toEqual({kind:'trade',text:'BTC-USD buy 0.0021 @ 83,489.561234'});
 expect(JSON.parse(input.text).events[0].trades[0].price).toBe('83489.561234');
 expect(coinbaseMessageSummary(row({channel:'heartbeats'}))).toEqual({kind:'heartbeat',text:'ok'});
 expect(messageTime(123)).toMatch(/\.123$/);
 expect(messageBytes(1536)).toBe('1.5 KB');
});
test('batched trades select latest event time, with market identity for mixed batches',()=>{
 const input=row({channel:'market_trades',events:[{trades:[{product_id:'BTC-USD',price:'100',time:'2026-10-19T12:00:02Z'},{product_id:'ETH-USD',price:'20',time:'2026-10-19T12:00:01Z'}]}]});
 expect(coinbaseMessageSummary(input).text).toBe('BTC-USD, ETH-USD · 2 trades batched · last BTC-USD 100');
 expect(coinbaseMessageSummary({...input,text:'invalid'}).text).toBe('invalid');
});
