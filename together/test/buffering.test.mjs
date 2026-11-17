import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {playbackPosition,setPlayback,updateGroupPlayback} from '../playback.mjs';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');

function setup() {
  const host={stream:true},friend={stream:true};
  const room={host:'host',members:new Map([['host',host],['friend',friend]])};
  setPlayback(room,'buffering',20,1000);
  function report(member,changes={}) {
    member.watch={sequence:room.playback.sequence,position:room.playback.position,duration:100,
      at:1000,bufferAhead:8,paused:true,blocked:false,waiting:false,...changes};
  }
  return {room,host,friend,report};
}

test('считаются только непрерывные загруженные данные вокруг текущей позиции',()=>{
  const values=[[0,22],[40,80]];
  const c=vm.createContext({movie:{currentTime:20,buffered:{length:2,start:i=>values[i][0],end:i=>values[i][1]}}});
  vm.runInContext(source.slice(source.indexOf('function bufferedAhead('),source.indexOf('function localTime(')),c);
  assert.equal(c.bufferedAhead(c.movie),2);
  values[1]=[22.1,29];
  assert.equal(c.bufferedAhead(c.movie),9);
});

test('старт ждёт всех подключённых зрителей и планируется на одно серверное время',()=>{
  const {room,host,friend,report}=setup();
  report(host);
  report(friend,{bufferAhead:2});
  assert.equal(updateGroupPlayback(room,1000),false);
  report(friend);
  assert.equal(updateGroupPlayback(room,1100),true);
  assert.equal(room.playback.phase,'playing');
  assert.ok(room.playback.at>1100);
  assert.equal(playbackPosition(room.playback,1100),20);
  assert.equal(playbackPosition(room.playback,room.playback.at+2000),22);
});

test('при небольшом запасе фильм идёт, при остановке у друга комната ждёт',()=>{
  const {room,host,friend,report}=setup();
  setPlayback(room,'playing',20,1000);
  report(host,{position:22,paused:false,at:3650});
  report(friend,{position:22,paused:false,at:3650,bufferAhead:2});
  assert.equal(updateGroupPlayback(room,3650),false);
  report(friend,{position:21.8,paused:false,at:3650,waiting:true,bufferAhead:0});
  assert.equal(updateGroupPlayback(room,3650),true);
  assert.equal(room.playback.phase,'buffering');
  assert.equal(room.playback.position,21.8);
});

test('повторная перемотка ждёт отчёты для новой позиции, даже если предыдущий отчёт был свежим',()=>{
  const {room,host,friend,report}=setup();
  report(friend);
  setPlayback(room,'buffering',91,1100);
  report(host,{at:1200});
  assert.equal(updateGroupPlayback(room,1200),false);
  report(friend,{position:20,at:1200});
  assert.equal(updateGroupPlayback(room,1200),false);
  report(friend,{at:1200});
  assert.equal(updateGroupPlayback(room,1200),true);
});

test('в конце учитывается оставшееся время, а вышедший зритель не блокирует просмотр',()=>{
  const {room,host,friend,report}=setup();
  friend.stream=null;
  setPlayback(room,'buffering',98,1000);
  report(host,{bufferAhead:2});
  assert.equal(updateGroupPlayback(room,1000),true);
});

test('комната ждёт, пока зритель разрешит воспроизведение в браузере',()=>{
  const {room,host,friend,report}=setup();
  report(host);
  report(friend,{blocked:true});
  assert.equal(updateGroupPlayback(room,1200),false);
  report(friend);
  assert.equal(updateGroupPlayback(room,1200),true);
});

test('пауза у зрителя ставит на ожидание всю комнату',()=>{
  const {room,host,friend,report}=setup();
  setPlayback(room,'playing',20,1000);
  report(host,{position:23,paused:false,at:4650});
  report(friend,{position:22.8,paused:true,at:4650});
  assert.equal(updateGroupPlayback(room,4650),true);
  assert.equal(room.playback.phase,'buffering');
  assert.equal(room.playback.position,22.8);
});

test('обрыв у зрителя удерживает комнату до нового отчёта после переподключения',()=>{
  const {room,host,friend,report}=setup();
  setPlayback(room,'playing',20,1000);
  friend.present=true;
  friend.stream=null;
  assert.equal(updateGroupPlayback(room,3000),true);
  report(host,{at:3000});
  report(friend,{at:3000});
  assert.equal(updateGroupPlayback(room,3000),false);
  friend.stream=true;
  friend.watch=null;
  assert.equal(updateGroupPlayback(room,3100),false);
  report(friend,{at:3200});
  assert.equal(updateGroupPlayback(room,3200),true);
});

test('комната ждёт зрителя, переставшего отправлять отчёты при открытом канале',()=>{
  const {room,host,friend,report}=setup();
  setPlayback(room,'playing',20,1000);
  report(host,{position:27,paused:false,at:8650});
  report(friend,{position:21,paused:false,at:2650});
  assert.equal(updateGroupPlayback(room,8650),true);
  assert.equal(room.playback.phase,'buffering');
  assert.equal(room.playback.position,21);
});
