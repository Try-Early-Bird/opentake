import { test, expect } from 'vitest';
import { appendChatFileText, readChatTextFiles } from '../../../src/shared/chat-file-input';
const file=(name:string,content:string,size=content.length)=>({name,size,text:async()=>content});
test('uploads preserve all reference columns and explanations for chat review',async()=>{
 const csv='venue,symbol,weight,reason\nrobinhood,VTI,70,"Broad market, long term"\nrobinhood,BND,30,Stability';
 const text=await readChatTextFiles([file('holdings.csv',csv),file('thesis.md','Quarterly rebalance; 5 percentage point drift.')]);
 expect(text).toContain(csv);expect(text).toContain('Quarterly rebalance; 5 percentage point drift.');
 expect(appendChatFileText('Please review before changing my take.',text)).toBe(`Please review before changing my take.\n\n${text}`);
});
test('uploads reject oversized, empty, binary and unsupported files without truncation',async()=>{
 for(const bad of [file('large.txt','x',1024*1024+1),file('empty.txt',' '),file('binary.csv','A\0B'),file('bad.txt','\uFFFD'),file('report.pdf','not text')])await expect(readChatTextFiles([bad])).rejects.toThrow();
 await expect(readChatTextFiles([file('large.txt','a'.repeat(12000))])).rejects.toThrow('message limit');
 await expect(readChatTextFiles([file('one.txt','a'.repeat(6000)),file('two.txt','b'.repeat(6000))])).rejects.toThrow('message limit');
 expect(()=>appendChatFileText('a'.repeat(11999),'x')).toThrow('12,000');
});
test('uploads propagate file read failures instead of treating them as empty content',async()=>{
 await expect(readChatTextFiles([{name:'holdings.tsv',size:10,text:async()=>{throw new Error('Read failed');}}])).rejects.toThrow('Read failed');
});
