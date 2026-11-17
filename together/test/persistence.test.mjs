import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(os.tmpdir(),'together-resume-'));process.env.DATA_DIR=directory;
const {createApp}=await import('../server.mjs');
const {waitForStreams}=await import('../video-streams.mjs');
test.after(()=>rm(directory,{recursive:true,force:true}));
async function start(){const server=await createApp();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,base:'http://127.0.0.1:'+server.address().port};}
async function post(base,route,input){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};}
test('обновление и перезапуск сохраняют идентификатор участника, комнату и ведущего',async()=>{
 let running=await start(),controller;
 try{
  const owner=(await post(running.base,'/api/rooms',{name:'Ведущий'})).value;
  const prefix='/api/rooms/'+owner.room;
  await post(running.base,prefix+'/join',{name:'Друг'});
  const reload=await post(running.base,prefix+'/join',{name:'Ведущий',token:owner.token});assert.equal(reload.status,200);assert.equal(reload.value.id,owner.id);
  running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));
  running=await start();
  const resumed=await post(running.base,prefix+'/join',{name:'Ведущий',token:owner.token});assert.equal(resumed.status,200);assert.equal(resumed.value.id,owner.id);assert.equal(resumed.value.room,owner.room);
  assert.equal((await post(running.base,prefix+'/join',{token:'invalid'})).status,401);
  controller=new AbortController();const response=await fetch(running.base+prefix+'/events?token='+owner.token,{signal:controller.signal});const reader=response.body.getReader();let text='';while(!text.includes('data: '))text+=new TextDecoder().decode((await reader.read()).value);const state=JSON.parse(text.split('data: ')[1].split('\n')[0]);assert.equal(state.members.length,2);assert.equal(state.host,owner.id);
 }finally{controller?.abort();running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));}
});

test('файл остаётся в библиотеке после замены и перезапуска, выбор сразу открывает тот же файл',async()=>{
 let running=await start();
 async function createRoom() {
  const member=(await post(running.base,'/api/rooms',{name:'Ведущий'})).value;
  const prefix=running.base+'/api/rooms/'+member.room;
  return {prefix,headers:{Authorization:'Bearer '+member.token}};
 }
 function upload(room,name,content) {
  return fetch(room.prefix+'/upload',{method:'POST',headers:{...room.headers,'X-File-Name':name},body:content});
 }
 function library(room,extra={}) {
  return fetch(room.prefix+'/library',{headers:{...room.headers,...extra}}).then(response=>response.json());
 }
 async function stop() {
  running.server.closeAllConnections();
  await new Promise(resolve=>running.server.close(resolve));
 }
 try {
  const first=await createRoom();
  assert.equal((await upload(first,'clip.mp4','first video')).status,200);
  assert.equal((await upload(first,'other.mp4','second video')).status,200);
  await waitForStreams();
  await stop();

  running=await start();
  const second=await createRoom();
  const {videos}=await library(second);
  assert.equal(videos.length,2);
  const saved=videos.find(video=>video.name==='clip.mp4');
  assert.ok(saved);
  const proxyHeaders={'X-Forwarded-For':'10.0.0.1','X-Library-Key':'a'.repeat(48)};
  assert.deepEqual((await library(second,proxyHeaders)).videos,[]);
  const select=headers=>fetch(second.prefix+'/select',{method:'POST',headers,body:JSON.stringify({id:saved.id})});
  assert.equal((await select({...second.headers,...proxyHeaders})).status,404);
  assert.equal((await select(second.headers)).status,200);
  const media=await fetch(second.prefix+'/media',{headers:second.headers}).then(response=>response.json());
  const video=await fetch(second.prefix+'/video?v='+media.version,{headers:second.headers});
  assert.equal(await video.text(),'first video');

  assert.equal((await upload(second,'clip.mp4','first video')).status,200);
  assert.equal((await library(second)).videos.length,2);
  assert.equal((await readdir(path.join(directory,'videos'))).filter(file=>file.endsWith('.video')).length,2);
 }finally{await stop();await waitForStreams();}
});
