import {test,expect} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordStartupFailure,startupFailureMessage,clearStartupFailure,desktopStartupMessage} from '../../src/main/host-startup';
test('startup errors report known causes without exposing raw errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opentake-startup-'));
 try{
  await recordStartupFailure(dir,new Error('Unsupported or modified database schema. Use a compatible app version.'));
  expect(await startupFailureMessage(dir)).toContain('migration history');
  await recordStartupFailure(dir,new Error('synthetic-private-payload'));
  expect(await startupFailureMessage(dir)).not.toContain('synthetic-private-payload');
  expect(desktopStartupMessage(new Error('synthetic-private-payload'))).not.toContain('synthetic-private-payload');
  expect(desktopStartupMessage(new Error('host_unresponsive'))).toContain('still running but is not responding');
  expect(desktopStartupMessage(new Error('host_shutdown_timeout'))).toContain('has not finished shutting down');
  expect(desktopStartupMessage(new Error('host_already_running'))).toContain('owns this profile');
  await writeFile(join(dir,'startup-failure.json'),JSON.stringify({code:'toString'}));expect(await startupFailureMessage(dir)).toBeNull();
  await clearStartupFailure(dir);expect(await startupFailureMessage(dir)).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('migration mismatch metadata survives startup reporting without allowing arbitrary payloads',async()=>{
 const {MigrationHistoryError}=await import('../../src/main/migration-error');
 const dir=await mkdtemp(join(tmpdir(),'opentake-migration-error-'));
 try{
  const mismatch={version:47,storedChecksum:'a'.repeat(64),expectedChecksum:'b'.repeat(64),latestSupportedVersion:49};
  await recordStartupFailure(dir,new MigrationHistoryError(mismatch));
  const message=await startupFailureMessage(dir);
  expect(message).toContain('version 47');expect(message).toContain('build supports through 49');
  expect(desktopStartupMessage(new Error(message!))).toBe(message);
  await recordStartupFailure(dir,new MigrationHistoryError({...mismatch,expectedChecksum:null}));
  expect(await startupFailureMessage(dir)).toContain('not supported by this build');
  await writeFile(join(dir,'startup-failure.json'),JSON.stringify({code:'schema',migration:{...mismatch,storedChecksum:'synthetic-private-payload'}}));
  expect(await startupFailureMessage(dir)).not.toContain('synthetic-private-payload');
  expect(desktopStartupMessage(new Error(message+' synthetic-private-payload'))).not.toContain('synthetic-private-payload');
 }finally{await rm(dir,{recursive:true,force:true});}
});
