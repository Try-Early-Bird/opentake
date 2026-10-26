import {expect,test} from 'vitest';
import {createWebsocketMessages} from '../../../src/main/data-sources/websocket/messages';
test('message journal caps rows/bytes, isolates revisions and maintains cursor after eviction',()=>{
 const journal=createWebsocketMessages();journal.add('a',1,'open','Connected');
 for(let i=0;i<300;i++)journal.add('a',1,'text','message '+i);
 const snapshot=journal.read('a',1);expect(snapshot.messages).toHaveLength(200);expect(snapshot.total).toBe(300);expect(snapshot.cursor).toBe(301);
 expect(journal.read('a',2).messages).toEqual([]);expect(journal.read('a',1,300).messages).toHaveLength(1);
 for(let i=0;i<200;i++)journal.add('a',1,'text','a'.repeat(65536));
 expect(Buffer.byteLength(JSON.stringify(journal.read('a',1)))).toBeLessThan(530000);
 snapshot.messages[0].text='mutated';expect(journal.read('a',1).messages.some(row=>row.text==='mutated')).toBe(false);
 const before=journal.read('a',1).cursor;journal.clear();expect(journal.read('a',1).messages).toEqual([]);journal.add('a',1,'text','new session');expect(journal.read('a',1,before).messages).toHaveLength(1);
});
