import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const screenFunctions=source.slice(source.indexOf('function updateScreenButton('),source.indexOf('function getLibraryKey('));

function setup({surface='window',restriction=true,supported=true,withAudio=true,audio=true}={}) {
  const video={readyState:'live',getSettings:()=>({displaySurface:surface}),addEventListener(){},stop(){this.readyState='ended';}};
  const sound={readyState:'live',getSettings:()=>({restrictOwnAudio:restriction}),stop(){this.readyState='ended';}};
  let sounds=audio?[sound]:[];
  const capture={
    getVideoTracks:()=>[video],getAudioTracks:()=>sounds,
    getTracks:()=>[video,...sounds],removeTrack:track=>{sounds=sounds.filter(sound=>sound!==track);}
  };
  const nodes=new Map([
    ['share-screen',{classList:{toggle(){}},setAttribute(){},lastElementChild:{}}],
    ['share-audio',{checked:withAudio,closest:()=>audioOption}],['call-note',{}]
  ]);
  const audioOption={hidden:false};
  let constraints;
  const sent=[];
  const context={
    session:{id:'owner'},displayCapture:null,screenCards:new Map(),peers:new Map(),
    navigator:{mediaDevices:{
      getSupportedConstraints:()=>({restrictOwnAudio:supported}),
      getDisplayMedia:async value=>{constraints=value;return capture;}
    }},
    $:id=>nodes.get(id),attachScreen(){},setCallView(){},
    sendTrack:async(kind,track)=>{sent.push({kind,track});},
    command:async()=>{},toast(message){context.message=message;}
  };
  vm.createContext(context);
  vm.runInContext(screenFunctions,context);
  return {context,nodes,capture,video,sound,sent,constraints:()=>constraints};
}

for(const surface of ['window','monitor']) {
  test('звук '+surface+' передаётся с подтверждённым исключением аудио Together',async()=>{
    const f=setup({surface});
    await f.context.toggleScreenShare();
    assert.equal(f.constraints().audio.restrictOwnAudio,true);
    assert.equal(f.constraints().selfBrowserSurface,'exclude');
    assert.equal(f.constraints().systemAudio,'include');
    assert.equal(f.constraints().windowAudio,'window');
    assert.equal(f.sent.find(item=>item.kind==='screenAudio').track,f.sound);
    assert.equal(f.sound.readyState,'live');
    assert.match(f.nodes.get('call-note').textContent,/со звуком/);
    assert.equal(f.nodes.get('share-audio').disabled,true);
  });
}

test('звук отдельной вкладки доступен без системного захвата аудио',async()=>{
  const f=setup({surface:'browser',supported:false,restriction:undefined});
  await f.context.toggleScreenShare();
  assert.equal(f.constraints().selfBrowserSurface,'exclude');
  assert.equal(f.constraints().systemAudio,'exclude');
  assert.equal(f.constraints().windowAudio,'exclude');
  assert.equal(f.sent.find(item=>item.kind==='screenAudio').track,f.sound);
});

test('звук окна отбрасывается, если браузер не исключил голоса и фильм Together',async()=>{
  const f=setup({restriction:false});
  await f.context.toggleScreenShare();
  assert.equal(f.sound.readyState,'ended');
  assert.equal(f.capture.getAudioTracks().length,0);
  assert.equal(f.sent.find(item=>item.kind==='screenAudio').track,null);
  assert.equal(f.sent.find(item=>item.kind==='screen').track,f.video);
  assert.match(f.nodes.get('call-note').textContent,/не смог исключить звук Together/);
});

test('выключенный звук демонстрации не попадает к участникам',async()=>{
  const f=setup({surface:'browser',withAudio:false});
  await f.context.toggleScreenShare();
  assert.equal(f.constraints().audio,false);
  assert.equal(f.constraints().systemAudio,'exclude');
  assert.equal(f.sound.readyState,'ended');
  assert.equal(f.sent.find(item=>item.kind==='screenAudio').track,null);
  assert.equal(f.nodes.get('call-note').textContent,'Демонстрация без звука.');
});

test('отсутствие дорожки звука объясняется пользователю',async()=>{
  const f=setup({audio:false});
  await f.context.toggleScreenShare();
  assert.equal(f.sent.find(item=>item.kind==='screen').track,f.video);
  assert.equal(f.sent.find(item=>item.kind==='screenAudio').track,null);
  assert.match(f.nodes.get('call-note').textContent,/Браузер передал только видео/);
});

test('остановка демонстрации освобождает обе дорожки и включает выбор звука',async()=>{
  const f=setup();
  await f.context.toggleScreenShare();
  await f.context.toggleScreenShare();
  assert.equal(f.video.readyState,'ended');
  assert.equal(f.sound.readyState,'ended');
  assert.equal(f.context.displayCapture,null);
  assert.equal(f.sent.at(-1).track,null);
  assert.equal(f.sent.at(-2).track,null);
  assert.equal(f.nodes.get('share-audio').disabled,false);
});

test('выход из комнаты во время выбора экрана завершает полученный захват',async()=>{
  const f=setup();
  f.context.navigator.mediaDevices.getDisplayMedia=async()=>{f.context.session=null;return f.capture;};
  await f.context.toggleScreenShare();
  assert.equal(f.video.readyState,'ended');
  assert.equal(f.sound.readyState,'ended');
  assert.equal(f.sent.length,0);
  assert.equal(f.nodes.get('share-audio').disabled,true);
});

test('браузер без захвата экрана скрывает управление своей демонстрацией',()=>{
  const f=setup();
  delete f.context.navigator.mediaDevices.getDisplayMedia;
  f.context.updateScreenButton();
  assert.equal(f.nodes.get('share-screen').hidden,true);
  assert.equal(f.nodes.get('share-audio').disabled,true);
  assert.equal(f.nodes.get('share-audio').closest('label').hidden,true);
  assert.equal(f.sent.length,0);
});

test('поддерживаемый захват экрана сохраняет доступ к звуку демонстрации',()=>{
  const f=setup();
  f.context.updateScreenButton();
  assert.equal(f.nodes.get('share-screen').hidden,false);
  assert.equal(f.nodes.get('share-audio').disabled,false);
  assert.equal(f.nodes.get('share-audio').closest('label').hidden,false);
});
