import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { imageSize } from 'image-size';
import { chatLimits } from '../shared/chat-limits';
import type { ImageAttachment } from '../shared/takes';

export async function prepareImage(name: unknown, encoded: unknown): Promise<{ metadata:ImageAttachment; base64:string }> {
 if(typeof name!=='string'||name.length>200||typeof encoded!=='string'||encoded.length>3*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('Choose a PNG, JPEG or WebP image up to 2 MB.');
 const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>chatLimits.imageBytes)throw new Error('Image must be between 1 byte and 2 MB.');
 let size;try{size=imageSize(bytes);}catch{throw new Error('Image could not be decoded.');}
 if(!['png','jpg','webp'].includes(size.type??'')||!size.width||!size.height||size.width*size.height>16000000||size.width>8000||size.height>8000)throw new Error('Use a PNG, JPEG or WebP image under 16 megapixels.');
 const decoder=sharp(bytes,{limitInputPixels:16000000,failOn:'warning'});
 const source=await decoder.metadata();
 if((source.pages??1)>1)throw new Error('Choose a still image, not an animation.');
 // Sharp strips metadata by default; orient before stripping EXIF and retain the format.
 const oriented=decoder.autoOrient();
 // Lossless screenshots stay lossless; JPEG keeps high-quality, full-resolution color.
 const output=size.type==='png'?oriented.png({compressionLevel:9}):size.type==='jpg'?oriented.jpeg({quality:95,chromaSubsampling:'4:4:4'}):oriented.webp({lossless:true});
 const {data:clean,info}=await output.toBuffer({resolveWithObject:true});
 if(!clean.length||clean.length>chatLimits.imageBytes)throw new Error('Image is too large after processing. Resize it and retry.');
 if(!['png','jpeg','webp'].includes(info.format)||info.width>8000||info.height>8000||info.width*info.height>16000000)throw new Error('Image could not be processed.');
 return {metadata:{id:randomUUID(),name:name.replace(/[\x00-\x1f/\\]/g,'').slice(0,120)||'Reference image',mime:`image/${info.format}` as ImageAttachment['mime'],width:info.width,height:info.height,bytes:clean.length},base64:clean.toString('base64')};
}

export function validateRunImages(images: ImageAttachment[], imageInput: boolean | undefined) {
 if(!images.length)return;
 if(imageInput!==true)throw new Error('Image support is not verified for this model. Choose an image-capable model or start a take without images.');
 if(new Set(images.map(i=>i.id)).size>chatLimits.uniqueImagesPerRun||images.reduce((n,i)=>n+i.bytes,0)>chatLimits.imageBytesPerRun)throw new Error('This response exceeds the image context limit (8 unique images or 12 MB). Start a new take.');
}
