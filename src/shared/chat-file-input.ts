/** Text uploads become editable message content; they never save a strategy directly. */
export const chatTextFilePattern = /\.(csv|tsv|txt|md|json)$/i;
export const chatMessageLimit = 12000;
export async function readChatTextFiles(files: readonly {name:string;size:number;text:()=>Promise<string>}[]):Promise<string> {
 const sections:string[]=[];
 for(const file of files){
  if(!chatTextFilePattern.test(file.name))throw new Error('Use CSV, TSV, TXT, Markdown, or JSON files.');
  if(file.size>1024*1024)throw new Error('Use text files smaller than 1 MB.');
  const content=await file.text();
  if(!content.trim())throw new Error(`${file.name} is empty.`);
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(content))throw new Error('Upload a UTF-8 text file.');
  sections.push(`Uploaded reference file ${JSON.stringify(file.name)}:\n${content}`);
  if(sections.join('\n\n').length>chatMessageLimit)throw new Error('These files exceed the message limit. Upload a smaller excerpt.');
 }
 return sections.join('\n\n');
}
export function appendChatFileText(draft:string,content:string):string {
 const next=[draft,content].filter(Boolean).join('\n\n');
 if(next.length>chatMessageLimit)throw new Error('The files and message exceed 12,000 characters. Shorten the message or upload a smaller excerpt.');
 return next;
}
