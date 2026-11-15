import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const devices=source.slice(source.indexOf('function deviceError('),source.indexOf('\nfunction updateDevices()'));
function fixture(getUserMedia, peers=new Map()){
  const nodes=new Map();
  const tracks=[];
  const context={navigator:{mediaDevices:{getUserMedia}},peers,media:{getTracks:()=>tracks.slice(),addTrack:t=>tracks.push(t),removeTrack:t=>{const i=tracks.indexOf(t);if(i>=0)tracks.splice(i,1);}},$:id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:''});return nodes.get(id);},console:{warn(){}},updateDevices(){},toast(message){context.lastToast=message;},DOMException};
  vm.createContext(context);vm.runInContext(devices+';globalThis.toggleDevice=toggle;',context);
  return {context,nodes,tracks};
}
function camera(){return {kind:'video',enabled:true,readyState:'live',stop(){this.readyState='ended';}};}
test('отказ разрешения остаётся видимым, кнопку можно нажать снова',async()=>{
  const error=new Error('denied');error.name='NotAllowedError';
  const f=fixture(async()=>{throw error;});await f.context.toggleDevice('video');
  assert.match(f.nodes.get('call-note').textContent,/NotAllowedError/);
  assert.equal(f.nodes.get('camera').disabled,false);assert.equal(f.tracks.length,0);
});
test('ошибка отправки одному участнику не отключает камеру и других участников',async()=>{
  const track=camera();let delivered;
  const peer=replaceTrack=>({pc:{signalingState:'stable',getTransceivers:()=>[{receiver:{track:{kind:'video'}},sender:{replaceTrack}}]}});
  const f=fixture(async()=>({getTracks:()=>[track]}),new Map([['bad',peer(async()=>{throw new Error('closed');})],['good',peer(async t=>{delivered=t;})]]));
  await f.context.toggleDevice('video');assert.equal(f.tracks[0],track);assert.equal(delivered,track);assert.equal(track.readyState,'live');assert.match(f.nodes.get('call-note').textContent,/передать/);
  await f.context.toggleDevice('video');assert.equal(track.readyState,'ended');assert.equal(f.tracks.length,0);assert.equal(delivered,null);
});
test('при несовместимых настройках камера запрашивается без ограничений',async()=>{
  let calls=0;const track=camera();
  const f=fixture(async constraints=>{if(++calls===1){const error=new Error();error.name='OverconstrainedError';throw error;}assert.equal(constraints.video,true);return {getTracks:()=>[track]};});
  await f.context.toggleDevice('video');assert.equal(calls,2);assert.equal(f.tracks[0],track);
});
