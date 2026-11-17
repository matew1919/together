import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function time('),source.indexOf('function destroyStreamPlayer('));
function setup(){const nodes=new Map();for(const id of ['time','seek','play','played-track'])nodes.set(id,{style:{},value:40,replaceChildren(){},append(){},setAttribute(){}});const c={room:null,streamCatalog:null,movie:{duration:200,currentTime:100,paused:false},isScrubbing:false,playbackIntent:()=>true,host:()=>true,$:id=>nodes.get(id),document:{activeElement:nodes.get('seek'),createTextNode:text=>({text}),createElement:()=>({})}};vm.createContext(c);vm.runInContext(functions,c);return {c,nodes};}
test('ползунок следует за видео даже когда после перемотки на нём остался фокус',()=>{const {c,nodes}=setup();c.updateTime();assert.equal(Number(nodes.get('seek').value),100);assert.equal(nodes.get('played-track').style.width,'50%');c.movie.currentTime=110;c.updateTime();assert.equal(Number(nodes.get('seek').value),110);assert.ok(Math.abs(parseFloat(nodes.get('played-track').style.width)-55)<0.01);});
test('во время перетаскивания точка и цветная полоса показывают выбранную позицию',()=>{const {c,nodes}=setup();c.isScrubbing=true;nodes.get('seek').value=60;c.updateTime();assert.equal(Number(nodes.get('seek').value),60);assert.equal(nodes.get('played-track').style.width,'30%');});
test('после завершения перетаскивания точка возвращается к текущему времени видео',()=>{const {c,nodes}=setup();c.isScrubbing=true;nodes.get('seek').value=60;c.updateTime();c.movie.currentTime=65;c.isScrubbing=false;c.updateTime();assert.equal(Number(nodes.get('seek').value),65);assert.equal(nodes.get('played-track').style.width,'32.5%');});

test('быстрые нажатия назад складываются до подтверждения сервера',async()=>{
  const commands=[],complete=[];
  const context=vm.createContext({
    session:{},version:'v1',connected:true,pendingSeek:null,host:()=>true,
    movie:{duration:100,currentTime:90},targetPosition:()=>90,
    writePlayback(action,position) {
      commands.push([action,position]);
      return new Promise(resolve=>complete.push(resolve));
    }
  });
  vm.runInContext(source.slice(source.indexOf('function seekTo('),source.indexOf('function updateHostRole(')),context);
  context.seekBy(-10);
  context.seekBy(-10);
  complete[0]();
  await Promise.resolve();
  context.seekBy(-10);
  assert.deepEqual(commands,[['seek',80],['seek',70],['seek',60]]);
  complete[1]();complete[2]();
});

test('шкала зрителя сразу показывает позицию комнаты до загрузки кадров',()=>{
  const {c,nodes}=setup();
  c.host=()=>false;
  c.movie.duration=NaN;
  c.movie.currentTime=10;
  c.sourceLoading=true;
  c.streamCatalog={duration:200};
  c.room={playback:{phase:'buffering',position:130}};
  c.targetPosition=()=>130;
  c.updateTime();
  assert.equal(Number(nodes.get('seek').value),130);
  assert.equal(nodes.get('played-track').style.width,'65%');
  assert.equal(c.movie.currentTime,10);
});
