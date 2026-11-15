import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {prepareStreams,describeStreams,streamAsset,authenticatedPlaylist,cancelStreams,waitForStreams} from '../video-streams.mjs';
const exec=promisify(execFile);
test('реальный MP4 превращается в HLS с оригиналом и 360p; ссылки защищены токеном',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'together-hls-'));
 const video={path:path.join(dir,'fixture.mp4'),version:'test-'+Date.now()};
 try{
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','6','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-y',video.path]);
  prepareStreams(video);await waitForStreams();const catalog=describeStreams(video);assert.equal(catalog.status,'ready');assert.deepEqual(catalog.variants.map(v=>v.id),['source','360']);assert.ok(catalog.variants.every(v=>v.ready));
  for(const quality of ['source','360']){
   const playlist=await streamAsset(video,quality,'index.m3u8');assert.ok(playlist);
   const text=await readFile(playlist.path,'utf8');assert.match(text,/#EXT-X-ENDLIST/);assert.match(text,/#EXT-X-MAP:URI="init.mp4"/);
   const rewritten=authenticatedPlaylist(text,'test-token');assert.match(rewritten,/init.mp4\?token=test-token/);assert.match(rewritten,/part-\d+.m4s\?token=test-token/);
   const init=await streamAsset(video,quality,'init.mp4');assert.ok(init.size>0);const part=await streamAsset(video,quality,'part-000000.m4s');assert.ok(part.size>0);
  }
  assert.equal(await streamAsset(video,'360','../../server.mjs'),null);assert.equal(await streamAsset(video,'720','index.m3u8'),null);
 }finally{await cancelStreams(video);await rm(dir,{recursive:true,force:true});}
});
test('HLS выдаётся только участнику комнаты, включая init и сегменты',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'together-hls-api-'));process.env.DATA_DIR=dir;
 const {createApp}=await import('../server.mjs');const server=await createApp();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  const fixture=path.join(dir,'input.mp4');await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:size=640x360:rate=12','-t','3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-y',fixture]);
  const response=await fetch(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"test"}'});const member=await response.json(),prefix=base+'/api/rooms/'+member.room;
  const headers={Authorization:'Bearer '+member.token};const upload=await fetch(prefix+'/upload',{method:'POST',headers:{...headers,'X-File-Name':'test.mp4'},body:await readFile(fixture)});assert.equal(upload.status,200);await waitForStreams();
  const catalog=await fetch(prefix+'/media',{headers}).then(r=>r.json());assert.equal(catalog.status,'ready');
  const stream=prefix+'/hls/'+catalog.version+'/360/';assert.equal((await fetch(stream+'index.m3u8')).status,401);
  const master=await fetch(prefix+'/hls/'+catalog.version+'/master.m3u8?token='+member.token).then(r=>r.text());assert.match(master,/360\/index.m3u8\?token=/);assert.doesNotMatch(master,/source\/index/);
  const manifest=await fetch(stream+'index.m3u8?token='+member.token).then(r=>r.text());assert.match(manifest,/init.mp4\?token=/);
  const init=await fetch(stream+'init.mp4?token='+member.token);assert.equal(init.status,200);assert.equal(init.headers.get('content-type'),'video/mp4');assert.ok((await init.arrayBuffer()).byteLength>0);
  const part=await fetch(stream+'part-000000.m4s?token='+member.token);assert.equal(part.status,200);assert.ok((await part.arrayBuffer()).byteLength>0);
  assert.equal((await fetch(prefix+'/hls/wrong/360/index.m3u8?token='+member.token)).status,404);
  await fetch(prefix+'/leave',{method:'POST',headers});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await waitForStreams();await rm(dir,{recursive:true,force:true});}
});

test('480p готовится только после запроса, 360p готовится по умолчанию',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'together-demand-'));const video={path:path.join(dir,'clip.mp4'),version:'demand-'+Date.now()};try{await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:size=640x480:rate=12','-t','3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-y',video.path]);prepareStreams(video);await waitForStreams();let catalog=describeStreams(video);assert.equal(catalog.variants.find(v=>v.id==='360').ready,true);assert.equal(catalog.variants.find(v=>v.id==='480').ready,false);assert.equal(catalog.variants.find(v=>v.id==='480').requested,false);prepareStreams(video,()=>{},'480');await waitForStreams();catalog=describeStreams(video);assert.equal(catalog.variants.find(v=>v.id==='480').ready,true);assert.equal(catalog.variants.find(v=>v.id==='480').requested,true);}finally{await cancelStreams(video);await rm(dir,{recursive:true,force:true});}});
