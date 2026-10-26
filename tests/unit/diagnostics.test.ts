import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createDiagnostics, readDiagnostics } from '../../src/main/diagnostics';

const directories: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'earlybird-log-test-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('writes structured events but excludes sensitive or arbitrary fields', () => {
  const root = directory();
  createDiagnostics(root, '0.1.0').record('database.failed', {
    durationMs: 42, password: 'secret', message: 'token=secret', stack: '/private/account',
    reason: 'secret', exitCode: NaN, holdings: { balance: 999 },
  });
  const raw = readFileSync(join(root, `app.${new Date().toISOString().slice(0,10)}.jsonl`), 'utf8');
  expect(raw).not.toMatch(/secret|private|holdings|balance|NaN/);
  expect(JSON.parse(raw)).toMatchObject({ event: 'database.failed', durationMs: 42 });
});

test('writes daily files instead of deleting history at a size threshold', () => {
 const root=directory();const log=createDiagnostics(root,'test');
 for(let i=0;i<100;i++)log.record('app.start');
 const files=readdirSync(root);expect(files).toEqual([`app.${new Date().toISOString().slice(0,10)}.jsonl`]);
 expect(readFileSync(join(root,files[0]),'utf8').trim().split('\n')).toHaveLength(100);
});

test('logging failures do not throw or print raw errors', () => {
  const root = directory();
  const file = join(root, 'blocked');
  writeFileSync(file, 'existing');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = createDiagnostics(file, '0.1.0');
  expect(() => { log.record('app.start'); log.record('app.start'); }).not.toThrow();
  expect(warning).toHaveBeenCalledExactlyOnceWith('Local diagnostics unavailable.');
});

test('log viewer merges process logs, preserves safe reasons and excludes arbitrary fields',async()=>{
 const root=directory(),takeId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 createDiagnostics(join(root,'logs','host'),'test').record('rebalance.decision',{venue:'coinbase',reason:'below_minimum',takeId,message:'secret',token:'secret'});
 createDiagnostics(join(root,'logs','desktop'),'test').record('app.start');
 const result=await readDiagnostics(root);
 expect(result.rows).toHaveLength(2);
 expect(result.rows.find(r=>r.source==='host')).toMatchObject({venue:'coinbase',reason:'below_minimum',takeId});
 expect(JSON.stringify(result)).not.toContain('secret');
 expect(result.truncated).toBe(false);
});
test('log viewer tolerates malformed trailing records and bounds the returned history',async()=>{
 const root=directory(),dir=join(root,'logs','host');
 createDiagnostics(dir,'test').record('app.start');
 const line=JSON.stringify({time:new Date().toISOString(),event:'background.completed',stage:'execution',message:'secret'});
 writeFileSync(join(dir,'app.jsonl'),Array(2001).fill(line).join('\n')+'\n{"incomplete":');
 const result=await readDiagnostics(root);expect(result.rows).toHaveLength(2000);expect(result.truncated).toBe(true);expect(JSON.stringify(result)).not.toContain('secret');
});

test('price diagnostics retain actionable context without arbitrary error text',async()=>{
 const root=directory();createDiagnostics(join(root,'logs','host'),'test').record('background.failed',{stage:'prices',venue:'robinhood',operation:'quotes',symbols:['AAPL','SPY','token=secret'],errorCode:'reauth_required',message:'secret'});
 const page=await readDiagnostics(root);expect(page.rows[0]).toMatchObject({venue:'robinhood',operation:'quotes',symbols:['AAPL','SPY'],errorCode:'reauth_required'});expect(JSON.stringify(page)).not.toContain('secret');
});

test('day retention defaults to thirty and shortening cleans both processes',async()=>{
 const {logRetention,setLogRetention,cleanDiagnosticLogs}=await import('../../src/main/diagnostic-retention');
 const root=directory(),logs=join(root,'logs');expect(logRetention(logs)).toBe(30);
 for(const source of ['host','desktop']){
  const dir=join(logs,source);createDiagnostics(dir,'test').record('app.start');
  const old=new Date(Date.now()-10*86400000).toISOString().slice(0,10);
  writeFileSync(join(dir,`app.${old}.jsonl`),JSON.stringify({time:old+'T12:00:00Z',event:'app.start'})+'\n');
 }
 expect(setLogRetention(logs,7)).toBe(7);expect(logRetention(logs)).toBe(7);
 for(const source of ['host','desktop'])expect(readdirSync(join(logs,source))).toHaveLength(1);
 expect(()=>setLogRetention(logs,0)).toThrow();expect(logRetention(logs)).toBe(7);
 cleanDiagnosticLogs(logs,Date.now()+9*86400000);
 expect((await readDiagnostics(root)).rows).toHaveLength(0);
});

test('broker response details survive capture and reading through the same allowlist',async()=>{
 const root=directory();
 createDiagnostics(join(root,'logs','host'),'test').record('broker.returned',{venue:'coinbase',operation:'submit_order',response:{success:true,success_response:{product_id:'BTC-USDC',side:'BUY'},token:'secret'}});
 const result=await readDiagnostics(root);
 expect(result.rows[0].response).toEqual({success:true,success_response:{product_id:'BTC-USDC',side:'BUY'}});
 expect(JSON.stringify(result)).not.toContain('secret');
});

test('broker request details survive capture without sensitive fields',async()=>{
 const root=directory();
 createDiagnostics(join(root,'logs','host'),'test').record('broker.called',{venue:'coinbase',operation:'submit_order',request:{product:'BTC-USDC',side:'buy',notional:'5',token:'secret',message:'secret'}});
 const result=await readDiagnostics(root);
 expect(result.rows[0].request).toEqual({product:'BTC-USDC',side:'buy',notional:'5'});
 expect(JSON.stringify(result)).not.toContain('secret');
});
