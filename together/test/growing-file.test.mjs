import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rename,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {followFile} from '../growing-file.mjs';
test('временный конец файла не завершает поток; новые части читаются после паузы и переименования',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'together-growing-'));const file=path.join(dir,'download.part');let finished=false;const controller=new AbortController();
 try {
  await writeFile(file,'first');const input=followFile(file,{finished:()=>finished,signal:controller.signal,pollMs:5});
  assert.equal((await input.next()).value.toString(),'first');
  let ended=false;const next=input.next().then(value=>{ended=true;return value;});await delay(25);assert.equal(ended,false);
  await appendFile(file,'second');assert.equal((await next).value.toString(),'second');
  const moved=path.join(dir,'movie.mp4');await rename(file,moved);await appendFile(moved,'last');assert.equal((await input.next()).value.toString(),'last');
  finished=true;assert.equal((await input.next()).done,true);
 }finally{controller.abort();await rm(dir,{recursive:true,force:true});}
});
test('ожидание новой части можно отменить',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'together-growing-abort-'));const file=path.join(dir,'empty');const controller=new AbortController();try{await writeFile(file,'');const input=followFile(file,{signal:controller.signal,pollMs:5});const next=input.next();controller.abort();await assert.rejects(next,{name:'AbortError'});}finally{await rm(dir,{recursive:true,force:true});}});
