import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createLiveSources} from '../live-source.mjs';
test('growing source publishes HLS before download ends, then restores completed stream', {timeout:30000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'together-live-')),live=createLiveSources(path.join(dir,'live'));
 try {
  const full=path.join(dir,'full.mp4'),partial=path.join(dir,'download.part');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','16','-c:v','libx264','-threads','2','-g','48','-movflags','+faststart',full]);
  const bytes=await readFile(full),cut=Math.floor(bytes.length*.8);await writeFile(partial,bytes.subarray(0,cut));
  const video=await live.start(partial);let status;
  for(let i=0;i<100;i++){status=live.describe(video);if(status.error||status.variants[0].ready)break;await delay(100);}
  assert.equal(status.error,null);assert.equal(status.variants[0].ready,true,'must publish before remaining bytes arrive');assert.equal(status.growing,true);
  const asset=await live.asset(video,'360','index.m3u8');assert.ok(asset);assert.ok(!(await readFile(asset.path,'utf8')).includes('#EXT-X-ENDLIST'));
  await appendFile(partial,bytes.subarray(cut));live.finish(video.liveId);await live.wait(video.liveId);
  status=live.describe(video);assert.equal(status.error,null);assert.equal(status.growing,false);assert.ok(status.duration>=15);
  assert.ok((await readFile(asset.path,'utf8')).includes('#EXT-X-ENDLIST'));
  const restored=createLiveSources(path.join(dir,'live'));assert.ok(await restored.restore(video.liveId));await restored.close();
 } finally{await live.close();await rm(dir,{recursive:true,force:true});}
});
test('server owner attaches local source; room members receive authenticated HLS only',{timeout:20000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'together-source-api-'));process.env.DATA_DIR=dir;
 const {createApp}=await import('../server.mjs'),server=await createApp();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try {
  const fixture=path.join(dir,'private.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=12','-t','8','-c:v','libx264','-threads','1','-movflags','+faststart',fixture]);
  const member=await fetch(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"owner"}'}).then(r=>r.json());
  const {port,key}=JSON.parse(await readFile(path.join(dir,'local-source-control.json'),'utf8'));
  const control=async(route,body)=>fetch('http://127.0.0.1:'+port+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const start=await control('/start',{room:member.room,file:fixture});assert.equal(start.status,200);const live=await start.json();
  const prefix=base+'/api/rooms/'+member.room,headers={Authorization:'Bearer '+member.token};let media;
  for(let i=0;i<100;i++){media=await fetch(prefix+'/media',{headers}).then(r=>r.json());if(media.error||media.variants[0]?.ready)break;await delay(100);}
  assert.equal(media.error,null);assert.equal(media.growing,true);assert.ok(media.variants[0].ready);assert.ok(!JSON.stringify(media).includes(dir));
  const playlist=prefix+'/hls/'+media.version+'/360/index.m3u8';assert.equal((await fetch(playlist)).status,401);
  const res=await fetch(playlist,{headers});assert.equal(res.status,200);const text=await res.text();assert.match(text,/init.mp4\?token=/);assert.ok(!text.includes('#EXT-X-ENDLIST'));
  assert.equal((await fetch(prefix+'/video?v='+media.version,{headers})).status,409);
  await control('/finish',{id:live.id});
  for(let i=0;i<100;i++){const status=await control('/status?id='+live.id).then(r=>r.json());if(!status.growing)break;await delay(100);}
  assert.match(await fetch(playlist,{headers}).then(r=>r.text()),/#EXT-X-ENDLIST/);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
test('MP4 with index after media returns a clear unsupported-source error',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'together-index-')),live=createLiveSources(path.join(dir,'live'));
 try{
  const fixture=path.join(dir,'input.mp4');const ftyp=Buffer.alloc(16);ftyp.writeUInt32BE(16,0);ftyp.write('ftyp',4);const mdat=Buffer.alloc(8);mdat.writeUInt32BE(8,0);mdat.write('mdat',4);await writeFile(fixture,Buffer.concat([ftyp,mdat]));
  const source=await live.start(fixture);await live.wait(source.liveId);assert.match(live.describe(source).error,/индекс находится после/);
 }finally{await live.close();await rm(dir,{recursive:true,force:true});}
});
