import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, readFile, rm, writeFile, stat, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { migrate, migrations } from '../../../src/main/migrations';
import { documentDirectory, documentFiles, documentHash } from '../../../src/main/document-files';
import { createDatabaseLifecycle } from '../../../src/main/database';
import { createTakeDocuments } from '../../../src/main/take-documents';
import { exportSnapshot } from '../../../src/main/database-tools';
import { decryptBackup } from '../../../src/main/backup-crypto';
import { validateArchive } from '../../../src/main/import-archive';
import { documentLimits } from '../../../src/shared/chat-documents';

async function take(db: Pick<PGlite,'query'>) {
 const id=randomUUID();
 await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic PDF','{}' FROM local_owners LIMIT 1",[id]);return id;
}
async function upload(docs:ReturnType<typeof createTakeDocuments>,takeId:string,data:Buffer){
 const {id}=await docs.action('begin',{takeId,name:'fixture.pdf',bytes:data.length}) as {id:string};
 for(let offset=0,ordinal=0;offset<data.length;offset+=documentLimits.chunkBytes,ordinal++)await docs.action('chunk',{id,ordinal,data:data.subarray(offset,offset+documentLimits.chunkBytes).toString('base64')});
 await docs.action('finish',{id});return id;
}
test('originals survive a schema upgrade and encrypted backup restore; damaged imports are refused', {timeout:90000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdf-disk-upgrade-')),oldPath=join(root,'database');
 const data=Buffer.alloc(documentLimits.chunkBytes+123,65);data.write('%PDF-synthetic');
 let old:PGlite|undefined=new PGlite(oldPath);
 const db=createDatabaseLifecycle(oldPath),restored=createDatabaseLifecycle(join(root,'restored'));
 try{
  await migrate(old,migrations.filter(m=>m.version<82));await old.close();old=undefined;
  await db.start();
  const takeId=await db.use(take);
  const id=await upload(createTakeDocuments(db,()=>documentDirectory(db.directory),async()=>({pages:['Synthetic text']})),takeId,data);
  const original=join(documentDirectory(db.directory),id+'.pdf');
  expect(await readFile(original)).toEqual(data);
  expect((await db.use(d=>d.query<{file_sha256:string}>('SELECT file_sha256 FROM take_documents WHERE id=$1',[id]))).rows[0].file_sha256).toBe(documentHash(data));
  if(process.platform!=='win32')expect((await stat(original)).mode&0o777).toBe(0o600);
  const backup=join(root,'fixture.ebbackup'),password='synthetic-test-passphrase';
  await db.use(d=>exportSnapshot(d,backup,password));
  const plaintext=await decryptBackup(await readFile(backup),password);
  await restored.start();await restored.replace(validateArchive(plaintext));plaintext.fill(0);
  expect(await readFile(join(documentDirectory(restored.directory),id+'.pdf'))).toEqual(data);
  const docs=createTakeDocuments(restored,()=>documentDirectory(restored.directory),async bytes=>{expect(Buffer.from(bytes)).toEqual(data);return {image:'AA=='};});
  expect(await docs.action('image',{id,page:1})).toEqual({image:'AA=='});
  // A corrupted imported attachment must never replace the active database.
  await writeFile(original,Buffer.alloc(data.length,66));
  const broken=await db.use(d=>d.dumpDataDir('gzip')),before=restored.directory;
  await expect(restored.replace(broken)).rejects.toThrow('missing or damaged');
  expect(restored.directory).toBe(before);
  expect(await readFile(join(documentDirectory(restored.directory),id+'.pdf'))).toEqual(data);
 }finally{await old?.close();await db.close();await restored.close();await rm(root,{recursive:true,force:true});}
});
test('multi-chunk file uploads resume, reject missing chunks, and clean staging and deleted originals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdf-disk-upload-')),db=new PGlite(),dir=documentDirectory(root);
 try{
  await migrate(db);const takeId=await take(db),data=Buffer.alloc(documentLimits.chunkBytes+13,65);data.write('%PDF-multiple');
  const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
  const processor=async(bytes:Uint8Array)=>{expect(Buffer.from(bytes)).toEqual(data);return {pages:['Synthetic text']};};
  let docs=createTakeDocuments(lifecycle,()=>dir,processor);
  const {id}=await docs.action('begin',{takeId,name:'../../report.pdf',bytes:data.length}) as {id:string};
  const first=data.subarray(0,documentLimits.chunkBytes).toString('base64');
  await docs.action('chunk',{id,ordinal:0,data:first});
  await expect(docs.action('finish',{id})).rejects.toThrow('Incomplete');
  docs=createTakeDocuments(lifecycle,()=>dir,processor);
  await docs.action('chunk',{id,ordinal:0,data:first});
  await docs.action('chunk',{id,ordinal:1,data:data.subarray(documentLimits.chunkBytes).toString('base64')});
  await docs.action('finish',{id});
  expect(await readdir(dir)).toEqual([id+'.pdf']);
  expect(await readFile(join(dir,id+'.pdf'))).toEqual(data);
  await expect(documentFiles(dir).read('../outside')).rejects.toThrow();
  await db.query('DELETE FROM takes WHERE id=$1',[takeId]);await docs.collect();expect(await readdir(dir)).toEqual([]);
  if(process.platform!=='win32'){
   const other=randomUUID();await writeFile(join(root,'outside'),'%PDF-private');await symlink(join(root,'outside'),join(dir,other+'.pdf'));
   await expect(documentFiles(dir).read(other)).rejects.toThrow();expect(await readFile(join(root,'outside'),'utf8')).toBe('%PDF-private');
  }
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
test('a missing original does not block startup and only that document becomes unavailable',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdf-disk-missing-')),path=join(root,'database');
 let db=createDatabaseLifecycle(path);
 try{
  await db.start();
  const takeId=await db.use(take),data=Buffer.from('%PDF-missing');
  const docs=createTakeDocuments(db,()=>documentDirectory(db.directory),async()=>({pages:['Synthetic text'],image:'AA=='}));
  const {id}=await docs.action('begin',{takeId,name:'gone.pdf',bytes:data.length}) as {id:string};
  await docs.action('chunk',{id,ordinal:0,data:data.toString('base64')});await docs.action('finish',{id});
  await db.close();
  await rm(join(documentDirectory(path),id+'.pdf'));
  db=createDatabaseLifecycle(path);await db.start();
  const reopened=createTakeDocuments(db,()=>documentDirectory(db.directory),async()=>({image:'AA=='}));
  await expect(reopened.action('image',{id,page:1})).rejects.toThrow();
  expect(await reopened.action('page',{id,page:1})).toMatchObject({text:'Synthetic text'});
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
