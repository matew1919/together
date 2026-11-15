import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const format=source.slice(source.indexOf('function time('),source.indexOf('\nfunction updateTime('));
const update=source.slice(source.indexOf('function updateParticipantTime('),source.indexOf('\nasync function shareWatchPosition('));
function setup(){const label={textContent:''},positions=new Map();const context={cards:new Map([['friend',{querySelector:()=>label}],['self',{querySelector:()=>label}]]),watchPositions:positions,session:{id:'self'},version:'v1',movie:{currentTime:125.2,paused:false,readyState:4}};vm.createContext(context);vm.runInContext(format+'\n'+update,context);return {context,label,positions};}
test('под карточкой показывается фактическое время участника и пауза',()=>{const f=setup();f.positions.set('friend',{version:'v1',position:65.8,paused:true,waiting:false,receivedAt:Date.now()});f.context.updateParticipantTime('friend');assert.equal(f.label.textContent,'01:05 · пауза');f.context.updateParticipantTime('self');assert.equal(f.label.textContent,'02:05 · смотрит');});
test('старые данные не выдаются за текущую позицию',()=>{const f=setup();f.positions.set('friend',{version:'v1',position:65,receivedAt:Date.now()-20000});f.context.updateParticipantTime('friend');assert.equal(f.label.textContent,'— · нет данных');f.positions.set('friend',{version:'old',position:65,receivedAt:Date.now()});f.context.updateParticipantTime('friend');assert.equal(f.label.textContent,'Ждёт видео');});
