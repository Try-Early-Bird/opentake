import { test,expect } from 'vitest';
import sharp from 'sharp';
import { prepareImage, validateRunImages } from '../../../src/main/take-images';
import type { ImageAttachment } from '../../../src/shared/takes';

test('normalization applies EXIF orientation, strips metadata and retains JPEG encoding',async()=>{
 const source=await sharp({create:{width:40,height:20,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const result=await prepareImage('../reference.jpg',source.toString('base64'));
 expect(result.metadata).toMatchObject({name:'..reference.jpg',width:20,height:40,mime:'image/jpeg'});
 const output=await sharp(Buffer.from(result.base64,'base64')).metadata();
 expect(output.orientation).toBeUndefined();expect(output.exif).toBeUndefined();expect(output.format).toBe('jpeg');
 expect(result.metadata.bytes).toBe(Buffer.from(result.base64,'base64').length);
});
test('normalization supports PNG and WebP and rejects invalid and oversized files',async()=>{
 for(const format of ['png','webp'] as const){const source=await sharp({create:{width:3,height:2,channels:3,background:'blue'}}).toFormat(format).toBuffer();expect((await prepareImage('image',source.toString('base64'))).metadata.mime).toBe(`image/${format}`);}
 for(const input of ['not base64!',Buffer.from('<svg/>').toString('base64'),Buffer.alloc(2*1024*1024+1).toString('base64')])await expect(prepareImage('reference.png',input)).rejects.toThrow();
 const source=await sharp({create:{width:3,height:2,channels:3,background:'blue'}}).png().toBuffer();
 await expect(prepareImage('broken.png',source.subarray(0,40).toString('base64'))).rejects.toThrow();
});
test('run image limits count unique images and every replayed occurrence and require verified capability',()=>{
 const img=(id:string,bytes=1):ImageAttachment=>({id,name:'x',mime:'image/png',width:1,height:1,bytes});
 expect(()=>validateRunImages([],undefined)).not.toThrow();
 for(const support of [undefined,false])expect(()=>validateRunImages([img('a')],support)).toThrow('not verified');
 expect(()=>validateRunImages(Array.from({length:8},(_,i)=>img(String(i))),true)).not.toThrow();
 expect(()=>validateRunImages(Array.from({length:9},(_,i)=>img(String(i))),true)).toThrow('image context');
 expect(()=>validateRunImages(Array(6).fill(img('same',2*1024*1024)),true)).not.toThrow();
 expect(()=>validateRunImages(Array(7).fill(img('same',2*1024*1024)),true)).toThrow('image context');
});

test('normalization checks encoded output size after processing',async()=>{
 const {randomBytes}=await import('node:crypto');
 const source=await sharp(randomBytes(2400*1800*3),{raw:{width:2400,height:1800,channels:3}}).jpeg({quality:25}).toBuffer();
 expect(source.length).toBeLessThan(2*1024*1024);
 const outcome=await prepareImage('noise.jpg',source.toString('base64')).then(()=> 'accepted',error=>error.message);expect(outcome).toContain('too large after processing');
});
