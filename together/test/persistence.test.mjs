import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(os.tmpdir(),'together-resume-'));process.env.DATA_DIR=directory;
const {createApp}=await import('../server.mjs');
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
 }finally{controller?.abort();running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
