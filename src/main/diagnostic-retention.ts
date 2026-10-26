import {mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export const LOG_RETENTION_DAYS=[1,7,14,30,90];
export function logRetention(logs:string):number{
 try{const value=JSON.parse(readFileSync(join(logs,'retention.json'),'utf8')).days;return LOG_RETENTION_DAYS.includes(value)?value:30;}catch{return 30;}
}
export function diagnosticFiles(directory:string):string[]{
 try{return readdirSync(directory).filter(name=>/^app(?:\.\d{4}-\d{2}-\d{2})?\.jsonl(?:\.[123])?$/.test(name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
export function cleanDiagnosticLogs(logs:string,now=Date.now(),sources=['host','desktop']):void{
 const cutoff=new Date(now-logRetention(logs)*86400000).toISOString().slice(0,10);
 for(const source of sources)for(const name of diagnosticFiles(join(logs,source))){
  const path=join(logs,source,name),day=/^app\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
  if(day){if(day<cutoff)rmSync(path,{force:true});continue;}
  // Migrate bounded legacy logs into date files once; no old size cap thereafter.
  const groups=new Map<string,string[]>();
  for(const line of readFileSync(path,'utf8').split('\n'))try{const row=JSON.parse(line);const date=new Date(row.time).toISOString().slice(0,10);if(date>=cutoff)groups.set(date,[...(groups.get(date)??[]),line]);}catch{}
  for(const [date,lines] of groups)writeFileSync(join(logs,source,`app.${date}.jsonl`),lines.join('\n')+'\n',{flag:'a',mode:0o600});
  rmSync(path,{force:true});
 }
}
export function setLogRetention(logs:string,days:unknown):number{
 if(typeof days!=='number'||!LOG_RETENTION_DAYS.includes(days))throw Error('Choose a supported log retention period.');
 mkdirSync(logs,{recursive:true,mode:0o700});
 const temp=join(logs,'retention.json.tmp');writeFileSync(temp,JSON.stringify({days}),{mode:0o600});renameSync(temp,join(logs,'retention.json'));
 cleanDiagnosticLogs(logs);return days;
}
