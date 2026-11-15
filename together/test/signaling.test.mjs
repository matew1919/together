import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const rtc=source.slice(source.indexOf('function summarizeCandidate('),source.indexOf('async function connectionReport()'))+source.slice(source.indexOf('function makePeer(id)'),source.indexOf('\nfunction deviceError('));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Stream {getTracks(){return [];}getVideoTracks(){return [];}addTrack(){}removeTrack(){}}
class Peer {
  constructor(){this.signalingState='stable';this.connectionState='new';this.transceivers=[];this.candidates=[];}
  addTransceiver(kind){this.transceivers.push({receiver:{track:{kind}},sender:{async replaceTrack(){},setStreams(){}}});}
  getTransceivers(){return this.transceivers;}
  async setLocalDescription(){this.localDescription={type:this.remoteDescription?.type==='offer'?'answer':'offer',sdp:'test'};this.signalingState=this.localDescription.type==='offer'?'have-local-offer':'stable';}
  async setRemoteDescription(value){assert.equal(this.busy,undefined,'remote descriptions must not overlap');this.busy=true;await delay(5);this.remoteDescription=value;this.signalingState=value.type==='offer'?'have-remote-offer':'stable';if(value.type==='offer'&&!this.transceivers.length){this.addTransceiver('audio');this.addTransceiver('video');}delete this.busy;}
  async addIceCandidate(candidate){assert.equal(this.busy,undefined,'ICE must wait for remote description');assert.ok(this.remoteDescription);this.candidates.push(candidate);}
}
function client(id,deliver){const context={session:{id},config:{iceServers:[]},peers:new Map(),media:new Stream(),MediaStream:Stream,RTCPeerConnection:Peer,console,setInterval(){},refreshPeerStatus(){},attach(){},command:async(action,payload)=>{deliver(id,payload);}};vm.createContext(context);vm.runInContext(rtc,context);return context;}
test('потерянное сообщение до подключения друга не мешает согласованию',async()=>{
 const contexts={},pending=[],sent=[];let error;
 const deliver=(from,{to,signal})=>{sent.push({from,to,signal});if(!contexts[to])return;queueMicrotask(()=>{const promise=contexts[to].signal(from,signal).catch(e=>{error=e;});pending.push(promise);});};
 contexts.a=client('a',deliver);contexts.a.makePeer('b');
 // Old participant's initial hello is dropped because the friend is not connected yet.
 await contexts.a.peers.get('b').pc.onnegotiationneeded();
 assert.equal(sent.filter(message=>message.signal.description).length,0);
 contexts.b=client('b',deliver);contexts.b.makePeer('a');
 for(let i=0;i<30;i++){await delay(5);if(contexts.b.peers.get('a').pc.localDescription?.type==='answer')break;}
 await Promise.all(pending);if(error)throw error;
 assert.equal(sent.filter(message=>message.signal.description?.type==='offer').length,1);
 assert.equal(contexts.a.peers.get('b').pc.remoteDescription.type,'answer');
 assert.equal(contexts.b.peers.get('a').pc.getTransceivers().length,2);
});
test('кандидат ICE ждёт завершения установки удалённого описания',async()=>{
 const c=client('z',()=>{});const p=c.makePeer('a');
 await Promise.all([c.signal('a',{description:{type:'offer',sdp:'test'}}),c.signal('a',{candidate:{candidate:'test-candidate'}})]);
 assert.equal(p.pc.candidates.length,1);
});
