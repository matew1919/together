import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function setParticipantsOpen('),source.indexOf('function closeScreenFullscreen('));
const viewFunctions=source.slice(source.indexOf('function setCallView('),source.indexOf('function addFocusButton('));
const fullscreenFunction=source.slice(source.indexOf('function fullscreenChanged('),source.indexOf("$('fullscreen').onclick"));
function setup() {
  const nodes=new Map();
  for(const id of ['participants-drawer','participants-toggle','participants-toggle-label','participants-count','participants-tiles','sidebar-tiles','call-tiles','people','player','cinema','call-stage','movie-mode','call-mode','fullscreen']) {
    nodes.set(id,{
      hidden:false,attributes:{},classList:{toggle(){}},
      setAttribute(key,value){this.attributes[key]=value;},
      append(node){node.parentElement=this;}
    });
  }
  let fullscreen=false;
  const context={
    participantsOpen:false,callView:false,session:{id:'self'},
    room:{members:[{id:'self'},{id:'friend'}]},
    $:id=>nodes.get(id),fullscreen:()=>fullscreen,showFullscreenControls(){},
    renderCallLayout(){context.refreshParticipantDrawer();}
  };
  vm.createContext(context);
  vm.runInContext(functions+viewFunctions+fullscreenFunction,context);
  return {context,nodes,setFullscreen:value=>{fullscreen=value;}};
}

test('при просмотре фильма участники всегда находятся справа над чатом',()=>{
  const {context,nodes}=setup();
  context.refreshParticipantDrawer();
  assert.equal(nodes.get('people').parentElement,nodes.get('sidebar-tiles'));
  assert.equal(nodes.get('participants-drawer').hidden,true);
  assert.equal(nodes.get('participants-toggle').hidden,true);
  assert.equal(nodes.get('participants-count').textContent,2);
});

test('полноэкранная лента открывается и закрывается с теми же карточками',()=>{
  const {context,nodes,setFullscreen}=setup();
  const people=nodes.get('people');
  setFullscreen(true);
  context.fullscreenChanged();
  assert.equal(people.parentElement,nodes.get('participants-tiles'));
  assert.equal(nodes.get('participants-toggle').hidden,false);
  assert.equal(nodes.get('participants-drawer').hidden,true);
  context.setParticipantsOpen(true);
  assert.equal(nodes.get('participants-drawer').hidden,false);
  assert.equal(nodes.get('participants-toggle').attributes['aria-expanded'],'true');
  context.setParticipantsOpen(false);
  assert.equal(nodes.get('participants-drawer').hidden,true);
  assert.equal(people.parentElement,nodes.get('participants-tiles'));
});

test('выход из полного экрана возвращает камеры над чатом даже при открытой ленте',()=>{
  const {context,nodes,setFullscreen}=setup();
  setFullscreen(true);
  context.fullscreenChanged();
  context.setParticipantsOpen(true);
  setFullscreen(false);
  context.fullscreenChanged();
  assert.equal(nodes.get('people').parentElement,nodes.get('sidebar-tiles'));
  assert.equal(nodes.get('participants-drawer').hidden,true);
  assert.equal(nodes.get('participants-toggle').attributes['aria-expanded'],'false');
});

test('после звонка те же карточки возвращаются над чатом',()=>{
  const {context,nodes}=setup();
  const people=nodes.get('people');
  context.refreshParticipantDrawer();
  context.setCallView(true);
  assert.equal(people.parentElement,nodes.get('call-tiles'));
  assert.equal(nodes.get('cinema').hidden,true);
  assert.equal(nodes.get('participants-drawer').hidden,true);
  context.setCallView(false);
  assert.equal(people.parentElement,nodes.get('sidebar-tiles'));
  assert.equal(nodes.get('cinema').hidden,false);
  assert.equal(nodes.get('participants-toggle').hidden,true);
});
