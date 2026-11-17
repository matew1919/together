import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('зритель возвращается после 94 секунд обрыва с тем же ID и токеном',async t=>{
  const data=await mkdtemp(path.join(tmpdir(),'together-reconnect-'));
  process.env.DATA_DIR=data;
  const {createApp}=await import('../server.mjs');
  const server=await createApp();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const controllers=[];
  const post=async(route,body)=>{
    const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,value:await response.json()};
  };
  const open=async member=>{
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(base+'/api/rooms/'+member.room+'/events?token='+member.token,{signal:controller.signal});
    return {controller,reader:response.body.getReader()};
  };
  try {
    const owner=(await post('/api/rooms',{name:'Ведущий'})).value;
    const prefix='/api/rooms/'+owner.room;
    const ownerEvents=await open(owner);
    const friend=(await post(prefix+'/join',{name:'Друг'})).value;
    const friendEvents=await open(friend);
    let pending='';
    const decoder=new TextDecoder();
    async function untilState(predicate) {
      while(true) {
        const boundary=pending.indexOf('\n\n');
        if(boundary>=0) {
          const block=pending.slice(0,boundary);pending=pending.slice(boundary+2);
          if(block.startsWith('event: state\n')) {
            const state=JSON.parse(block.split('\ndata: ')[1]);
            if(predicate(state))return state;
          }
        } else {
          const {value,done}=await ownerEvents.reader.read();
          assert.equal(done,false);
          pending+=decoder.decode(value,{stream:true});
        }
      }
    }
    await untilState(state=>state.members.some(member=>member.id===friend.id&&member.online));
    t.mock.timers.enable({apis:['setTimeout']});
    friendEvents.controller.abort();
    await untilState(state=>state.members.some(member=>member.id===friend.id&&!member.online));
    t.mock.timers.tick(94000);
    const resumed=await post(prefix+'/join',{name:'Друг',token:friend.token});
    assert.equal(resumed.status,200);
    assert.equal(resumed.value.id,friend.id);
    assert.equal(resumed.value.token,friend.token);
    await open(friend);
    const state=await untilState(state=>state.members.some(member=>member.id===friend.id&&member.online));
    assert.equal(state.members.length,2);
    assert.equal(state.host,owner.id);
  } finally {
    for(const controller of controllers)controller.abort();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    t.mock.timers.reset();
    await rm(data,{recursive:true,force:true});
  }
});

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const recovery=source.slice(source.indexOf('function resumeConnection()'),source.indexOf('setInterval(()=>{if(events&&'));
function setup() {
  const listeners=new Map(),calls=[];
  const context={
    session:{id:'self'},connected:true,events:{readyState:1},EventSource:{OPEN:1},
    lastRoomEvent:100000,reconnectTimer:null,Date:{now:()=>100000},
    document:{hidden:false,addEventListener:(type,callback)=>listeners.set(type,callback)},
    window:{addEventListener:(type,callback)=>listeners.set(type,callback)},
    clearTimeout:timer=>calls.push(['cancel',timer]),
    reconnect:reason=>calls.push(['reconnect',reason]),
    syncPlayback:()=>calls.push(['sync']),scheduleWatch:()=>calls.push(['watch'])
  };
  vm.createContext(context);vm.runInContext(recovery,context);
  return {context,listeners,calls};
}

test('возвращение во вкладку возобновляет зависшее переподключение',()=>{
  const f=setup();f.context.connected=false;f.context.reconnectTimer=7;
  f.listeners.get('visibilitychange')();
  assert.deepEqual(f.calls,[['cancel',7],['reconnect','heartbeat_timeout']]);
  assert.equal(f.context.reconnectTimer,null);
});

test('восстановление сети обновляет канал с просроченным heartbeat',()=>{
  const f=setup();f.context.lastRoomEvent=0;
  f.listeners.get('online')();
  assert.deepEqual(f.calls,[['cancel',null],['reconnect','heartbeat_timeout']]);
});

test('возвращение при живом канале сохраняет подключение и обновляет плеер',()=>{
  const f=setup();f.listeners.get('visibilitychange')();
  assert.deepEqual(f.calls,[['sync'],['watch']]);
  f.calls.length=0;f.context.document.hidden=true;
  f.listeners.get('visibilitychange')();
  assert.deepEqual(f.calls,[]);
});

test('после выхода из комнаты восстановление сети не создаёт новое подключение',()=>{
  const f=setup();f.context.session=null;
  f.listeners.get('online')();
  assert.deepEqual(f.calls,[]);
});
