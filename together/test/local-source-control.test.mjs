import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {localSourceControl} from '../local-source-control.mjs';
import {watchReady,updateGroupPlayback} from '../playback.mjs';
test('local source control requires secret and rejects browser origins',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'together-control-'));
 const control=await localSourceControl(dir,{rooms:()=>[{id:'room'}]});
 try{
  const {port,key}=JSON.parse(await readFile(path.join(dir,'local-source-control.json'),'utf8')),url='http://127.0.0.1:'+port+'/rooms';
  assert.equal((await fetch(url)).status,403);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+key,Origin:'https://example.com'}})).status,403);
  const res=await fetch(url,{headers:{Authorization:'Bearer '+key}});assert.equal(res.status,200);assert.deepEqual(await res.json(),{rooms:[{id:'room'}]});
 }finally{control.close();await rm(dir,{recursive:true,force:true});}
});
test('growing video waits for five seconds and buffers at temporary end',()=>{
 const now=10000,playback={phase:'buffering',sequence:1,position:8,paused:true,at:now};
 const watch={sequence:1,position:8,duration:10,paused:true,waiting:false,bufferAhead:2,at:now};
 assert.equal(watchReady(playback,watch,now,false),true);assert.equal(watchReady(playback,watch,now,true),false);
 const room={video:{growing:true},host:'owner',members:new Map([['owner',{stream:true,watch:{...watch,paused:false,position:10,bufferAhead:0}}]]),playback:{...playback,phase:'playing',paused:false,at:7000}};
 assert.equal(updateGroupPlayback(room,now),true);assert.equal(room.playback.phase,'buffering');
});
