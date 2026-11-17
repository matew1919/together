import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const role=source.slice(source.indexOf('function updateHostRole('),source.indexOf('function renderHostSelector('));
const access=source.slice(source.indexOf('function access()'),source.indexOf('function state('));
test('только ведущий получает кнопки управления и выбора видео',()=>{
 const nodes=new Map(),c={room:{host:'matvey'},session:{id:'matvey'},version:'v1',connected:true,upload:null,toast(){},$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}};
 c.host=()=>c.room.host===c.session.id;vm.createContext(c);vm.runInContext(role+access,c);
 c.updateHostRole('ilsur');c.access();
 for(const id of ['play','seek','back','pick','replace'])assert.equal(nodes.get(id).disabled,false,id);
 c.session.id='ilsur';c.access();
 for(const id of ['play','seek','back','pick','replace'])assert.equal(nodes.get(id).disabled,true,id);
});
test('Матвей после передачи может управлять плеером, загрузкой и ведущим',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'together-host-'));process.env.DATA_DIR=directory;
 const {createApp}=await import('../server.mjs');const {waitForStreams}=await import('../video-streams.mjs');const server=await createApp();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const post=async(route,data,member)=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(member?{Authorization:'Bearer '+member.token}:{})},body:JSON.stringify(data)});return {status:response.status,value:await response.json()};};
 try{
  const owner=(await post('/api/rooms',{name:'Ильсур'})).value,prefix='/api/rooms/'+owner.room;const friend=(await post(prefix+'/join',{name:'Матвей'})).value;
  const upload=member=>fetch(base+prefix+'/upload',{method:'POST',headers:{Authorization:'Bearer '+member.token,'X-File-Name':'test.mp4'},body:'test video'});
  assert.equal((await upload(owner)).status,200);const media=await fetch(base+prefix+'/media',{headers:{Authorization:'Bearer '+friend.token}}).then(r=>r.json());
  assert.equal((await post(prefix+'/host',{id:friend.id},owner)).status,200);
  assert.equal((await post(prefix+'/playback',{position:15,paused:false,version:media.version},friend)).status,200);
  assert.equal((await post(prefix+'/playback',{position:30,paused:true,version:media.version},friend)).status,200);
  assert.equal((await post(prefix+'/playback',{position:1,paused:false,version:media.version},owner)).status,403);
  assert.equal((await upload(owner)).status,403);assert.equal((await upload(friend)).status,200);
  assert.equal((await post(prefix+'/host',{id:owner.id},friend)).status,200);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await waitForStreams();await rm(directory,{recursive:true,force:true});}
});
