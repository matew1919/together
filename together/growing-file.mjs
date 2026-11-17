import {open} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// EOF in an unfinished download is temporary. Only the caller's explicit
// completion signal closes the input; a download pause must not truncate it.
export async function* followFile(file,{signal,finished=()=>false,pollMs=250,chunkSize=256*1024,maxBytes=8*1024**3,handle:providedHandle}={}) {
  let handle=providedHandle,offset=0;
  try {
    while(!handle) {
      signal?.throwIfAborted();
      try{handle=await open(file,'r');}
      catch(error){if(error.code!=='ENOENT'||finished())throw error;await delay(pollMs,undefined,{signal});}
    }
    while(true) {
      signal?.throwIfAborted();
      const info=await handle.stat();
      if(!info.isFile())throw new Error('Источник должен быть обычным файлом');
      if(info.size>maxBytes)throw new Error('Превышен лимит размера видео');
      if(info.size<offset)throw new Error('Скачиваемый файл был обнулён или заменён');
      if(info.size>offset) {
        const buffer=Buffer.allocUnsafe(Math.min(chunkSize,info.size-offset));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
        if(bytesRead){offset+=bytesRead;yield buffer.subarray(0,bytesRead);continue;}
      }
      if(finished())return;
      await delay(pollMs,undefined,{signal});
    }
  } finally {await handle?.close();}
}
