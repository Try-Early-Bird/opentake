// What changed between two versions of an MCP tool's definition, in the member's
// words: shown in chat's access request and in Settings → MCP.
type Definition={name:string;description?:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>};
export interface ToolChange {field:string;before:string|null;after:string|null}
const object=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown)=>value===undefined?null:typeof value==='string'?value:JSON.stringify(value);
/** One field's shape, so a type, enum or description change shows on its own line. */
function describe(schema:unknown){const s=object(schema);const parts=[s.type!==undefined?`type ${text(s.type)}`:null,s.enum?`one of ${(s.enum as unknown[]).map(v=>text(v)).join(', ')}`:null,s.format?`format ${text(s.format)}`:null,s.description?`“${text(s.description)}”`:null];
 const rest=Object.fromEntries(Object.entries(s).filter(([k])=>!['type','enum','format','description'].includes(k)));
 return [...parts.filter(Boolean),Object.keys(rest).length?JSON.stringify(rest):null].filter(Boolean).join(' · ')||'any value';}
export function toolChanges(before:Definition|null|undefined,after:Definition):ToolChange[]{
 if(!before)return [];
 const changes:ToolChange[]=[];
 if((before.description??'')!==(after.description??''))changes.push({field:'Description',before:before.description??null,after:after.description??null});
 const old=object(before.inputSchema.properties),next=object(after.inputSchema.properties);
 for(const key of [...new Set([...Object.keys(old),...Object.keys(next)])].sort()){
  const a=key in old?describe(old[key]):null,b=key in next?describe(next[key]):null;
  if(a!==b)changes.push({field:`Input “${key}”`,before:a,after:b});
 }
 const required=(schema:Record<string,unknown>)=>Array.isArray(schema.required)?[...schema.required as string[]].sort().join(', '):'';
 if(required(before.inputSchema)!==required(after.inputSchema))changes.push({field:'Required inputs',before:required(before.inputSchema)||'None',after:required(after.inputSchema)||'None'});
 const rest=(schema:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([k])=>!['properties','required'].includes(k))));
 if(rest(before.inputSchema)!==rest(after.inputSchema))changes.push({field:'Input rules',before:rest(before.inputSchema),after:rest(after.inputSchema)});
 if(JSON.stringify(before.outputSchema??null)!==JSON.stringify(after.outputSchema??null))changes.push({field:'Output',before:text(before.outputSchema)??'Not described',after:text(after.outputSchema)??'Not described'});
 return changes;
}

/** A sentence part: plain, emphasized (what was added) or a field name. */
export interface SummaryPart {text:string;strong?:boolean;code?:boolean}
/** What a value is, in words: "an email address", "a number". */
export function valueNoun(schema:unknown){const s=object(schema);const format=typeof s.format==='string'?s.format:'';
 if(format==='email')return 'an email address';if(format==='uri'||format==='url')return 'a link';if(format==='date'||format==='date-time')return 'a date';
 if(Array.isArray(s.enum))return 'one of a set of values';
 const type=Array.isArray(s.type)?s.type[0]:s.type;return type==='number'||type==='integer'?'a number':type==='boolean'?'a yes or no':type==='array'?'a list':type==='object'?'a group of values':type==='string'?'some text':'a value';}
const words=(value:string)=>value.trim().split(/\s+/).filter(Boolean);
/** Words added to a description, when the rest is unchanged (otherwise null). */
function addedWords(before:string,after:string){
 const a=words(before.replace(/[.]$/,'')),b=words(after.replace(/[.]$/,''));let start=0;while(start<a.length&&a[start]===b[start])start++;
 let end=0;while(end<a.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
 return start+end===a.length&&b.length>a.length?b.slice(start,b.length-end).join(' '):null;
}
/** One plain sentence about how a tool changed, built from the definitions themselves. */
export function toolChangeSummary(before:Definition|null|undefined,after:Definition):SummaryPart[]{
 if(!before)return [];
 const clauses:SummaryPart[][]=[];
 const oldText=before.description??'',newText=after.description??'';
 if(oldText!==newText){const added=addedWords(oldText,newText);
  clauses.push(added?[{text:'its description now adds “'},{text:added,strong:true},{text:'”'}]:[{text:'its description now reads “'},{text:newText||'(none)',strong:true},{text:'”'}]);}
 const old=object(before.inputSchema.properties),next=object(after.inputSchema.properties);
 const required=(schema:Record<string,unknown>)=>new Set(Array.isArray(schema.required)?schema.required as string[]:[]);
 const wasRequired=required(before.inputSchema),isRequired=required(after.inputSchema);
 for(const key of Object.keys(next).filter(k=>!(k in old)))clauses.push(isRequired.has(key)?[{text:`it needs ${valueNoun(next[key])} `},{text:key,code:true},{text:' every time'}]:[{text:'it now accepts an optional '},{text:key,code:true}]);
 for(const key of Object.keys(old).filter(k=>!(k in next)))clauses.push([{text:'it no longer takes '},{text:key,code:true}]);
 for(const key of Object.keys(next).filter(k=>k in old)){
  if(valueNoun(old[key])!==valueNoun(next[key]))clauses.push([{text:key,code:true},{text:` is now ${valueNoun(next[key])}`}]);
  if(!wasRequired.has(key)&&isRequired.has(key))clauses.push([{text:'it now always needs '},{text:key,code:true}]);
 }
 if(JSON.stringify(before.outputSchema??null)!==JSON.stringify(after.outputSchema??null))clauses.push([{text:'it returns a different result'}]);
 if(!clauses.length)return [{text:'Its input rules changed. See the full definition.'}];
 const parts:SummaryPart[]=[];
 clauses.forEach((clause,i)=>{if(i)parts.push({text:i===clauses.length-1?', and ':', '});parts.push(...clause);});
 parts[0]={...parts[0],text:parts[0].text.charAt(0).toUpperCase()+parts[0].text.slice(1)};parts.push({text:'.'});
 return parts;
}
