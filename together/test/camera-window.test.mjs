import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function refreshCameraWindow('),source.indexOf('function summarizeCandidate('));

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};}
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  setAttribute(key,value){this.attributes[key]=value;}
  querySelector(selector){return this.children.find(child=>selector.startsWith('.')?child.className===selector.slice(1):child.tag===selector);}
  remove(){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
  async play(){}
}
class Stream {
  constructor(tracks){this.tracks=tracks;}
  getVideoTracks(){return this.tracks.filter(track=>track.kind==='video');}
  getAudioTracks(){return this.tracks.filter(track=>track.kind==='audio');}
}
function setup() {
  const events=new Map(),windowEvents=new Map();
  const doc={
    head:new Element('head'),body:new Element('body'),createElement:tag=>new Element(tag),
    addEventListener:(type,callback)=>events.set(type,callback),
    getElementById:id=>doc.body.children.find(child=>child.id===id)
  };
  const popup={
    document:doc,closed:false,
    addEventListener:(type,callback)=>windowEvents.set(type,callback),
    close(){this.closed=true;windowEvents.get('pagehide')?.();}
  };
  const button=new Element('button'),cards=new Map(),tracks=[];
  for(const id of ['self','friend']) {
    const track={id,kind:'video',readyState:'live',enabled:true,muted:false};
    const card=new Element('div'),video=new Element('video'),name=new Element('span');
    video.srcObject=new Stream([track,{kind:'audio'}]);video.hidden=false;
    name.className='person-name';name.textContent=id;
    card.append(video,name);cards.set(id,card);tracks.push(track);
  }
  let requests=0;
  const context={
    session:{id:'self'},cards,MediaStream:Stream,URL,location:{href:'http://localhost:3000/'},
    cameraWindow:null,cameraWindowGrid:null,cameraWindowOpening:false,cameraWindowCards:new Map(),
    $:()=>button,window:{documentPictureInPicture:{requestWindow:async()=>{requests++;return popup;}}},
    toast(message){context.message=message;}
  };
  vm.createContext(context);vm.runInContext(functions,context);
  return {context,popup,button,tracks,events,windowEvents,requests:()=>requests};
}

test('одно окно показывает все камеры, копируя только видеодорожки',async()=>{
  const f=setup();
  await f.context.toggleCameraWindow();
  assert.equal(f.requests(),1);
  assert.equal(f.context.cameraWindowCards.size,2);
  assert.equal(f.button.attributes['aria-pressed'],'true');
  assert.equal(f.button.hidden,false);
  for(const [id,tile] of f.context.cameraWindowCards) {
    const video=tile.querySelector('video');
    assert.equal(video.muted,true);
    assert.equal(video.srcObject.getAudioTracks().length,0);
    assert.equal(video.srcObject.getVideoTracks()[0].id,id);
  }
  assert.equal(f.context.cards.size,2);
});

test('правый клик закрывает окно камер и сохраняет исходные видеодорожки',async()=>{
  const f=setup();
  await f.context.toggleCameraWindow();
  const previews=[...f.context.cameraWindowCards.values()];
  let prevented=false;
  f.events.get('contextmenu')({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(f.popup.closed,true);
  assert.equal(f.context.cameraWindow,null);
  assert.equal(f.button.attributes['aria-pressed'],'false');
  assert.ok(f.tracks.every(track=>track.readyState==='live'));
  assert.ok(previews.every(tile=>tile.querySelector('video').srcObject===null));
});

test('выключение камеры убирает миниатюру, повторное включение возвращает её',async()=>{
  const f=setup();
  await f.context.toggleCameraWindow();
  f.tracks[1].muted=true;
  f.context.refreshCameraWindow();
  assert.equal(f.context.cameraWindowCards.size,1);
  f.tracks[1].muted=false;
  f.context.refreshCameraWindow();
  assert.equal(f.context.cameraWindowCards.size,2);
  assert.equal(f.requests(),1);
});

test('выход участника удаляет его миниатюру из общего окна',async()=>{
  const f=setup();
  await f.context.toggleCameraWindow();
  f.context.cards.delete('friend');
  f.context.refreshCameraWindow();
  assert.equal(f.context.cameraWindowCards.size,1);
  assert.equal(f.context.cameraWindowCards.has('friend'),false);
});

test('закрытие средствами браузера сбрасывает кнопку и ссылки на миниатюры',async()=>{
  const f=setup();
  await f.context.toggleCameraWindow();
  f.popup.close();
  assert.equal(f.context.cameraWindow,null);
  assert.equal(f.context.cameraWindowCards.size,0);
  assert.equal(f.button.attributes['aria-pressed'],'false');
});

test('параллельные нажатия открывают одно окно, выход во время открытия закрывает его',async()=>{
  const f=setup();
  let complete;
  f.context.window.documentPictureInPicture.requestWindow=()=>new Promise(resolve=>{complete=resolve;});
  const opening=f.context.toggleCameraWindow();
  await f.context.toggleCameraWindow();
  f.context.session=null;
  complete(f.popup);
  await opening;
  assert.equal(f.popup.closed,true);
  assert.equal(f.context.cameraWindow,null);
  assert.equal(f.context.cameraWindowOpening,false);
  assert.equal(f.button.disabled,true);
});

test('неподдерживаемый браузер получает объяснение, ошибка открытия допускает повтор',async()=>{
  const f=setup();
  f.context.window.documentPictureInPicture=null;
  f.context.refreshCameraWindow();
  assert.equal(f.button.disabled,true);
  assert.equal(f.button.hidden,true);
  await f.context.toggleCameraWindow();
  assert.match(f.context.message,/Chrome/);
  f.context.window.documentPictureInPicture={requestWindow:async()=>{throw new Error('denied');}};
  await f.context.toggleCameraWindow();
  assert.equal(f.context.cameraWindowOpening,false);
  assert.equal(f.button.disabled,false);
  assert.equal(f.context.cameraWindow,null);
});
