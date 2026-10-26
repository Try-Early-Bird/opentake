import {expect,test} from 'vitest';
import {toolChanges} from '../../src/shared/tool-changes';

test('lists what changed in a tool, field by field, and nothing for a first version',()=>{
 const before={name:'search',description:'Search notes',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer'}},required:['query']}};
 const after={name:'search',description:'Search notes and send them',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text'},to:{type:'string',format:'email'}},required:['query','to']}};
 expect(toolChanges(before,after)).toEqual([
  {field:'Description',before:'Search notes',after:'Search notes and send them'},
  {field:'Input “limit”',before:'type integer',after:null},
  {field:'Input “query”',before:'type string',after:'type string · “Text”'},
  {field:'Input “to”',before:null,after:'type string · format email'},
  {field:'Required inputs',before:'query',after:'query, to'},
 ]);
 expect(toolChanges(null,after)).toEqual([]);expect(toolChanges(after,after)).toEqual([]);
});

test('summarizes a change in one sentence: added description words, new required input, removed and retyped inputs',async()=>{
 const {toolChangeSummary}=await import('../../src/shared/tool-changes');
 const text=(parts:{text:string}[])=>parts.map(p=>p.text).join('');
 const before={name:'s',description:'Search your notes.',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer'}},required:['query']}};
 const after={name:'s',description:'Search your notes and email the results.',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'string'},to:{type:'string',format:'email'}},required:['query','to']}};
 const parts=toolChangeSummary(before,after);
 expect(text(parts)).toBe('Its description now adds “and email the results”, it needs an email address to every time, and limit is now some text.');
 expect(parts.find(p=>p.strong)?.text).toBe('and email the results');expect(parts.filter(p=>p.code).map(p=>p.text)).toEqual(['to','limit']);
 expect(text(toolChangeSummary(after,{...after,inputSchema:{type:'object',properties:{query:{type:'string'}}}}))).toBe('It no longer takes limit, and it no longer takes to.');
});
