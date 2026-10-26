/** Source coordinates only. Never return the message, full stack/path, or args. */
export function cryptoFailureSite(error:unknown):string|null {
 if(!(error instanceof Error)||typeof error.stack!=='string')return null;
 for(const line of error.stack.split('\n').slice(1,12)){
  if(!/^\s+at /.test(line))continue;
  const match=line.match(/[/\\]out[/\\]main[/\\](index\.js|chunks[/\\][A-Za-z0-9_-]+\.js):(\d{1,8}):(\d{1,6})\)?$/);
  if(match)return `${match[1].replaceAll('\\','/')}:${match[2]}:${match[3]}`;
 }
 return null;
}
