import { MigrationHistoryError, validMigrationMismatch, migrationMismatchMessage } from './migration-error';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite } from './private-files';
const messages = {
 schema: 'The local database was created by a different or modified migration history. Use a compatible app build. Your data has not been reset.',
 permissions: 'The background host could not access its local files. Check the app profile’s filesystem permissions.',
 disk: 'The background host could not start because the disk is full.',
 database: 'The background host failed while opening or initializing the local database. Your data has not been reset.',
};
export function startupFailureCode(error:unknown):keyof typeof messages {
 if(error instanceof Error&&error.message==='Unsupported or modified database schema. Use a compatible app version.')return 'schema';
 const code=(error as {code?:string}|null)?.code;
 return code==='EACCES'||code==='EPERM'?'permissions':code==='ENOSPC'?'disk':'database';
}
export async function recordStartupFailure(profile:string,error:unknown){await atomicPrivateWrite(join(profile,'startup-failure.json'),Buffer.from(JSON.stringify({code:startupFailureCode(error),...(error instanceof MigrationHistoryError && validMigrationMismatch(error.mismatch) ? {migration:error.mismatch} : {})})));}
export async function clearStartupFailure(profile:string){await rm(join(profile,'startup-failure.json'),{force:true});}
export async function startupFailureMessage(profile:string):Promise<string|null>{
 try{const {code,migration}=JSON.parse(await readFile(join(profile,'startup-failure.json'),'utf8'));return Object.hasOwn(messages,code)?messages[code as keyof typeof messages]+(code==='schema'&&validMigrationMismatch(migration)?'\n\n'+migrationMismatchMessage(migration):''):null;}catch{return null;}
}
export function desktopStartupMessage(error:unknown):string {
 const text=error instanceof Error?error.message:'';
 const hostMessages: Record<string,string> = {
  host_unresponsive: 'An existing Opentake background host is still running but is not responding. Finish any macOS Keychain prompt, or use the Opentake menu-bar icon → Quit completely, then retry. Your data has not been reset.',
  host_shutdown_timeout: 'The previous Opentake background host has not finished shutting down. Wait for active work to finish, then retry. Your data has not been reset.',
  host_already_running: 'Another Opentake background host owns this profile but has not become ready. Finish any pending system prompt or quit that instance completely, then retry. Your data has not been reset.',
  host_exited: 'The Opentake background host exited before it became ready. Check the local startup diagnostics. Your data has not been reset.',
  host_launch_failed: 'Opentake could not launch its background process. Check that the Electron installation is complete and executable. Your data has not been reset.',
  host_startup_timeout: 'The Opentake background host is taking longer than expected to start. Check for a pending system prompt, then retry. Your data has not been reset.',
 };
 if (Object.hasOwn(hostMessages,text)) return hostMessages[text];
 if (text.startsWith(messages.schema+'\n\nMigration diagnostic: ') && /^Migration diagnostic: version [1-9]\d*; stored [a-f0-9]{64}; expected (?:[a-f0-9]{64}|not supported by this build); build supports through [1-9]\d*\.$/.test(text.slice((messages.schema+'\n\n').length))) return text;
 return Object.values(messages).includes(text)?text:'Opentake could not start its background host. Close older instances and check disk space and permissions. Existing data has not been reset.';
}
