import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const temp=await mkdtemp(path.join(os.tmpdir(),'together-test-'));
process.env.DATA_DIR=temp;
const {createApp}=await import('../server.mjs');
test('комната, доступы, события, видео и передача ведущего',async t=>{
  const server=await createApp();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const streams=[];
  const request=async(url,data,member)=>{const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(member?{Authorization:'Bearer '+member.token}:{})},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};};
  const create=await request('/api/rooms',{name:'Ведущий'});assert.equal(create.status,201);const owner=create.data;
  const prefix='/api/rooms/'+owner.room;
  const joined=await request(prefix+'/join',{name:'Друг'});assert.equal(joined.status,200);const friend=joined.data;
  const open=async member=>{const controller=new AbortController();streams.push(controller);const response=await fetch(base+prefix+'/events?token='+member.token,{signal:controller.signal});const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';return async type=>{const timeout=setTimeout(()=>controller.abort(),5000);try{while(true){const index=buffer.indexOf('\n\n');if(index>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);if(block.startsWith('event: '+type+'\n'))return JSON.parse(block.split('\ndata: ')[1]);}else{const {value,done}=await reader.read();if(done)throw new Error('SSE closed');buffer+=decoder.decode(value,{stream:true});}}}finally{clearTimeout(timeout);}};};
  try{
    const next=await open(friend),initial=await next('state');assert.equal(initial.members.length,2);assert.equal(initial.host,owner.id);
    assert.equal((await request(prefix+'/playback',{position:1,paused:false},friend)).status,403);
    assert.equal((await fetch(base+prefix+'/video')).status,401);
    const payload=Buffer.from('fake-video-for-range-test');
    const uploaded=await fetch(base+prefix+'/upload',{method:'POST',headers:{Authorization:'Bearer '+owner.token,'X-File-Name':encodeURIComponent('Проверка.mp4'),'Content-Type':'application/octet-stream'},body:payload});assert.equal(uploaded.status,200);
    let updated;do{updated=await next('state');}while(!updated.video);
    const v=updated.video.version;assert.equal(updated.video.name,'Проверка.mp4');
    const videoUrl=base+prefix+'/video?token='+friend.token+'&v='+v;
    const range=await fetch(videoUrl,{headers:{Range:'bytes=2-7'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 2-7/${payload.length}`);assert.equal(await range.text(),payload.subarray(2,8).toString());
    assert.equal((await fetch(videoUrl,{headers:{Range:'bytes=999-'}})).status,416);
    const suffix=await fetch(videoUrl,{headers:{Range:'bytes=-4'}});assert.equal(await suffix.text(),payload.subarray(-4).toString());
    const playback=await request(prefix+'/playback',{position:12,paused:false,version:v},owner);assert.equal(playback.status,200);const played=await next('playback');assert.equal(played.position,12);assert.equal(played.paused,false);
    assert.equal((await request(prefix+'/playback',{position:1,paused:true,version:'stale'},owner)).status,409);
    await request(prefix+'/chat',{text:'<script>test</script>'},friend);const message=await next('chat');assert.equal(message.text,'<script>test</script>');assert.equal(message.name,'Друг');
    assert.equal((await request(prefix+'/host',{id:friend.id},friend)).status,403);
    assert.equal((await request(prefix+'/host',{id:friend.id},owner)).status,200);
    assert.equal((await request(prefix+'/playback',{position:15,paused:true,version:v},friend)).status,200);
    await request(prefix+'/leave',{},friend);
    // The remaining member becomes host automatically.
    assert.equal((await request(prefix+'/playback',{position:16,paused:true,version:v},owner)).status,200);
    const wrongOrigin=await fetch(base+'/api/rooms',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});assert.equal(wrongOrigin.status,403);
    const full=await fetch(videoUrl);assert.equal(full.status,401);
    await request(prefix+'/leave',{},owner);
  }finally{for(const controller of streams)controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
});
