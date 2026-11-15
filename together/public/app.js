'use strict';
const $=id=>document.getElementById(id),movie=$('movie'),peers=new Map(),cards=new Map(),media=new MediaStream();
let session,room,config,events,version,upload,toastTimer,applyingUntil=0,pending,connected=false,joining=false;
let requestedRoom=new URLSearchParams(location.search).get('room');
const watchPositions=new Map();
let isScrubbing=false;
let playbackIntent=false,bufferHolding=false,bufferChecking=false,autoplayBlocked=false,bufferPausePosition=null,peerBufferOverride=false;
let playbackWrite=Promise.resolve(),playbackRevision=0;
let streamPlayer=null,streamCatalog=null,currentStream='original',sourceResume=null,streamManifest=null,qualityPreference='auto',mediaPolling=false,streamWatchdog=null,streamGeneration=0;
const host=()=>!!session&&!!room&&room.host===session.id;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
const endpoint=action=>`/api/rooms/${encodeURIComponent(session.room)}/${action}`;
async function api(url,data,auth=true){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(auth&&session?{Authorization:'Bearer '+session.token}:{})},body:JSON.stringify(data)});const result=await response.json();if(!response.ok){const error=new Error(result.error||'Ошибка сервера');error.status=response.status;throw error;}return result;}
const command=(action,data)=>api(endpoint(action),data);
function time(seconds){seconds=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));return (seconds>=3600?Math.floor(seconds/3600)+':':'')+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
function updateTime(){
  const duration=Number.isFinite(movie.duration)?movie.duration:0;
  const position=isScrubbing?Number($('seek').value):movie.currentTime||0;
  $('time').replaceChildren(document.createTextNode(time(position)+' '));
  const span=document.createElement('span');span.textContent='/ '+time(duration);$('time').append(span);
  $('seek').max=duration||100;
  if(!isScrubbing)$('seek').value=position;
  const active=host()?playbackIntent:!movie.paused;
  $('play').textContent=active?'Ⅱ':'▶';$('play').setAttribute('aria-label',active?'Пауза':'Воспроизвести');
  $('played-track').style.width=(duration?Math.min(100,position/duration*100):0)+'%';
}

function destroyStreamPlayer() {
  clearTimeout(streamWatchdog);streamWatchdog=null;streamPlayer?.destroy();streamPlayer=null;
  if(streamManifest){URL.revokeObjectURL(streamManifest);streamManifest=null;}
}
function originalVideoUrl(){return endpoint('video')+'?token='+encodeURIComponent(session.token)+'&v='+encodeURIComponent(version);}
function qualityUrl(quality){return location.origin+endpoint('hls')+'/'+encodeURIComponent(version)+'/'+quality+'/index.m3u8?token='+encodeURIComponent(session.token);}
function showQualities(catalog) {
  const select=$('quality'),chosen=qualityPreference;
  select.replaceChildren();
  for(const [value,label]of [['auto','Авто'],['original','Оригинал']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
  for(const variant of catalog?.variants||[]) {
    if(variant.id==='source')continue;
    const option=document.createElement('option');option.value=variant.id;
    option.textContent=variant.height+'p'+(variant.ready?'':variant.failed?' · недоступно':variant.processing||variant.requested?' · готовится':' · по запросу');
    option.disabled=variant.failed;select.append(option);
  }
  select.value=[...select.options].some(option=>option.value===chosen)?chosen:'auto';
}
async function useQuality(choice,automatic=false) {
  if(!session||!version)return;
  const expectedVersion=version;
  const available=(streamCatalog?.variants||[]).filter(variant=>variant.ready);
  const variants=choice==='original'?[]:choice==='auto'?available.filter(v=>v.id!=='source'&&v.height<=720):available.filter(v=>v.id===choice);
  if(!variants.length&&choice!=='auto'&&choice!=='original'){
    if(!automatic){try{const response=await fetch(endpoint('media')+'?quality='+encodeURIComponent(choice),{headers:{Authorization:'Bearer '+session.token}});if(!response.ok)throw new Error();streamCatalog=await response.json();showQualities(streamCatalog);toast('Готовим '+choice+'p. Пока оставляю текущее качество.');}catch{toast('Не удалось запустить подготовку качества');}}
    return;
  }
  if(!variants.length) {
    if(!automatic&&choice!=='auto'&&choice!=='original')toast('Это качество ещё готовится');
    if(currentStream==='original')return;
  }
  const target=variants.length?(choice==='auto'?'auto:'+variants.map(v=>v.id).join(','):variants[0].id):'original';
  if(target===currentStream)return;
  if(automatic&&currentStream!=='original'&&choice==='auto')return;
  const generation=++streamGeneration;playbackRevision++;
  const resume={position:movie.readyState?movie.currentTime:(pending?.position||0),shouldPlay:host()?playbackIntent:pending?!pending.paused:!movie.paused};
  if(host()&&playbackIntent)await holdForBuffer();
  if(generation!==streamGeneration||!session||version!==expectedVersion)return;
  sourceResume=resume;destroyStreamPlayer();currentStream=target;
  movie.preload='auto';
  if(variants.length&&typeof Hls!=='undefined'&&Hls.isSupported()) {
    streamPlayer=new Hls({enableWorker:true,maxBufferLength:120,maxMaxBufferLength:180,maxBufferSize:128*1024*1024,backBufferLength:30,startPosition:resume.position,capLevelToPlayerSize:choice==='auto',startLevel:0,abrEwmaDefaultEstimate:700000,abrBandWidthFactor:0.7,abrBandWidthUpFactor:0.5});
    const hls=streamPlayer;
    const sourceUrl=choice==='auto'?location.origin+endpoint('hls')+'/'+encodeURIComponent(version)+'/master.m3u8?token='+encodeURIComponent(session.token):qualityUrl(variants[0].id);
    let recoveries=0;
    const fallback=reason=>{
      if(streamPlayer!==hls||!session||!version)return;
      toast('Поток не загрузился ('+reason+'). Открываю оригинал.');
      sourceResume=resume;destroyStreamPlayer();currentStream='original';qualityPreference='original';showQualities(streamCatalog);movie.src=originalVideoUrl();movie.load();
    };
    hls.on(Hls.Events.ERROR,(_,data)=>{
      if(!data.fatal)return;
      if(++recoveries>2){fallback(data.details||'ошибка');return;}
      if(data.type===Hls.ErrorTypes.NETWORK_ERROR){if(String(data.details).toLowerCase().includes('manifest'))hls.loadSource(sourceUrl);else hls.startLoad(movie.currentTime||resume.position);}
      else if(data.type===Hls.ErrorTypes.MEDIA_ERROR)hls.recoverMediaError();
      else fallback(data.details||'ошибка');
    });
    hls.on(Hls.Events.FRAG_BUFFERED,()=>{clearTimeout(streamWatchdog);streamWatchdog=null;});
    hls.on(Hls.Events.MEDIA_ATTACHED,()=>hls.loadSource(sourceUrl));hls.attachMedia(movie);
    streamWatchdog=setTimeout(()=>{if(movie.readyState<2)fallback('нет кадров за 15 секунд');},15000);
  } else {
    movie.src=variants.length&&movie.canPlayType('application/vnd.apple.mpegurl')?qualityUrl(variants[0].id):originalVideoUrl();movie.load();
  }
}
async function pollStreams() {
  if(mediaPolling||!session||!version)return;
  const expected=version;mediaPolling=true;
  try {
    const response=await fetch(endpoint('media'),{headers:{Authorization:'Bearer '+session.token}});
    if(!response.ok)return;
    const catalog=await response.json();if(version!==expected)return;
    streamCatalog=catalog;showQualities(catalog);
    await useQuality(qualityPreference,true);
  }catch{}finally{mediaPolling=false;}
}
setInterval(()=>{if(streamCatalog?.status!=='ready'&&streamCatalog?.status!=='failed')pollStreams();},4000);
function bufferedAhead(video, position=video.currentTime || 0) {
  let end=position;
  for(let i=0;i<video.buffered.length;i++) {
    const start=video.buffered.start(i),rangeEnd=video.buffered.end(i);
    if(start<=end+0.15 && rangeEnd>position)end=Math.max(end,rangeEnd);
  }
  return Math.max(0,end-position);
}
function bufferReady(video, minimum=5) {
  if(video.seeking || video.readyState<3)return false;
  const remaining=Number.isFinite(video.duration)?Math.max(0,video.duration-video.currentTime):Infinity;
  return bufferedAhead(video)>=Math.min(minimum,remaining)-0.15;
}
function bufferWaiters() {
  const waiters=[];
  if(!room||!session)return waiters;
  const starting=bufferHolding||movie.paused;
  if(!bufferReady(movie,starting?5:1))waiters.push({id:session.id,name:'Ты',reason:movie.seeking?'завершаем перемотку':movie.readyState<3&&bufferedAhead(movie)>5?'подготавливаем кадры':'буфер '+time(bufferedAhead(movie))});
  if(peerBufferOverride)return waiters;
  for(const member of room.members) {
    if(member.id===session.id)continue;
    const report=watchPositions.get(member.id),name=member.name||'Участник';
    let reason='';
    if(!report||Date.now()-report.receivedAt>8000)reason='нет свежих данных';
    else if(report.version!==version)reason='открывает видео';
    else if(Math.abs(report.position+(report.paused?0:(Date.now()-report.receivedAt)/1000)-movie.currentTime)>=2)reason='переходит к '+time(movie.currentTime);
    else if(starting?!report.readyToPlay:report.waiting||report.bufferAhead<Math.min(1,Math.max(0,movie.duration-report.position))-0.15)reason='буфер '+time(report.bufferAhead||0);
    if(reason)waiters.push({id:member.id,name,reason});
  }
  return waiters;
}
function updateBufferDisplay() {
  const ahead=bufferedAhead(movie);
  $('buffer-health').textContent=version?'Загружено вперёд: '+time(ahead)+(streamPlayer?.bandwidthEstimate?' · '+(streamPlayer.bandwidthEstimate/1000000).toFixed(1)+' Мбит/с':''):'У каждого своя громкость. У всех один момент.';
  const track=$('buffered-track');track.replaceChildren();
  if(Number.isFinite(movie.duration)&&movie.duration>0)for(let i=0;i<movie.buffered.length;i++) {
    const segment=document.createElement('span');segment.style.left=(movie.buffered.start(i)/movie.duration*100)+'%';segment.style.width=((movie.buffered.end(i)-movie.buffered.start(i))/movie.duration*100)+'%';track.append(segment);
  }
  const leader=room?.host&&watchPositions.get(room.host);
  const waitingForGroup=host()?bufferHolding:leader?.version===version&&leader?.buffering&&Date.now()-leader.receivedAt<8000;
  const localWaiting=!!version&&!movie.paused&&(movie.readyState<3||movie.seeking);
  $('buffer-overlay').hidden=!version||(!waitingForGroup&&!localWaiting);
  const waiters=host()?bufferWaiters():[];
  const remoteWaiters=waiters.filter(waiter=>waiter.id!==session?.id);
  const ownWaiter=waiters.find(waiter=>waiter.id===session?.id);
  $('buffer-message').textContent=waitingForGroup?(ownWaiter?'Подготавливаем твоё видео…':remoteWaiters.length?'Ждём: '+remoteWaiters.map(waiter=>waiter.name).join(', '):'Готово, продолжаем…'):'Подгружаем видео…';
  $('buffer-description').textContent='Твой буфер: '+time(ahead)+(host()&&waiters.length?' · '+waiters.map(waiter=>waiter.name+': '+waiter.reason).join('; '):leader?.bufferReason?' · '+leader.bufferReason:'');
  $('continue-buffer').hidden=!host()||!bufferHolding||!!ownWaiter||!remoteWaiters.length;

}
function writePlayback(position,paused) {
  const expectedVersion=version,expectedSession=session?.id;
  playbackWrite=playbackWrite.catch(()=>{}).then(()=>{
    if(!session||session.id!==expectedSession||version!==expectedVersion)return;
    if(!host())return;
    return command('playback',{position,paused,version:expectedVersion});
  });
  return playbackWrite;
}
async function holdForBuffer() {
  if(!host()||!version||!playbackIntent)return;
  const entering=!bufferHolding,position=movie.currentTime||0;
  bufferHolding=true;movie.pause();updateBufferDisplay();
  // A second seek while already buffering must update every viewer's target too.
  if(entering||bufferPausePosition===null||Math.abs(bufferPausePosition-position)>0.1) {
    bufferPausePosition=position;
    await writePlayback(position,true).catch(error=>toast(error.message));
    shareWatchPosition();
  }
}

async function checkPlaybackBuffer() {
  if(bufferChecking||!host()||!version||!playbackIntent||autoplayBlocked||!connected)return;
  bufferChecking=true;
  const revision=playbackRevision;
  try {
    const ready=bufferWaiters().length===0;
    if(!ready) {await holdForBuffer();return;}
    if(bufferHolding||movie.paused) {
      bufferHolding=false;
      try {
        await movie.play();if(revision!==playbackRevision){movie.pause();return;}$('enable-play').hidden=true;
        await writePlayback(movie.currentTime||0,false);
        shareWatchPosition();
      } catch(error) {
        if(error.name==='NotAllowedError') {autoplayBlocked=true;$('enable-play').hidden=false;}
        else {playbackIntent=false;toast('Не удалось начать воспроизведение: '+error.message);}
      }
    }
  } finally {bufferChecking=false;updateBufferDisplay();}
}
async function requestPlayPause() {
  if(!host()||!version)return;
  playbackRevision++;autoplayBlocked=false;peerBufferOverride=false;bufferPausePosition=null;
  if(playbackIntent) {
    playbackIntent=false;bufferHolding=false;movie.pause();
    await writePlayback(movie.currentTime||0,true).catch(error=>toast(error.message));
  } else {
    playbackIntent=true;
    // Start in the user's click handler to unlock media playback, then hold while buffering.
    const unlock=movie.play();
    await holdForBuffer();
    unlock.catch(error=>{if(error.name==='NotSupportedError')toast('Формат видео не поддерживается браузером');});
    await checkPlaybackBuffer();
  }
  updateTime();updateBufferDisplay();
}
function seekTo(position) {
  if(!host()||!version)return;
  playbackRevision++;peerBufferOverride=false;
  movie.currentTime=Math.max(0,Math.min(Number.isFinite(movie.duration)?movie.duration:position,position));
  if(playbackIntent)holdForBuffer();
  else publish();
  updateTime();updateBufferDisplay();
}
setInterval(checkPlaybackBuffer,500);
setInterval(updateBufferDisplay,1000);
for(const event of ['progress','loadedmetadata','canplay','canplaythrough','waiting','stalled','seeking','seeked','playing','pause','emptied'])movie.addEventListener(event,()=>{
  updateBufferDisplay();
  if(['waiting','seeking'].includes(event)&&host()&&playbackIntent)holdForBuffer();
  if(['canplay','canplaythrough','progress','seeked'].includes(event))checkPlaybackBuffer();
});
async function publish(){if(!host()||!version||Date.now()<applyingUntil||!connected)return;try{await writePlayback(movie.currentTime||0,movie.paused);}catch(e){toast(e.message);}}
async function apply(playback,force=false){pending=playback;if(!version||!movie.readyState||(!force&&host()))return;applyingUntil=Date.now()+700;const target=playback.position+(playback.paused?0:Math.max(0,(Date.now()-playback.at)/1000));const drift=Math.abs(movie.currentTime-target);const stalled=!movie.paused&&movie.readyState<3;if(Number.isFinite(movie.duration)&&drift>.7&&(!stalled||playback.paused||force||drift>15))movie.currentTime=Math.min(target,movie.duration);if(playback.paused){movie.pause();$('enable-play').hidden=true;}else{try{await movie.play();$('enable-play').hidden=true;}catch{$('enable-play').hidden=false;}}updateTime();}
function updateHostRole(previousHost) {
  if(previousHost===room.host)return;
  playbackRevision++;
  bufferHolding=false;bufferChecking=false;bufferPausePosition=null;peerBufferOverride=false;autoplayBlocked=false;
  playbackIntent=host()&&!room.playback.paused;
  if(sourceResume)sourceResume.shouldPlay=!room.playback.paused;
  $('continue-buffer').hidden=true;
  if(previousHost&&room.host===session.id)toast('Теперь ты ведущий: доступны плеер, загрузка видео и передача управления.');
}
function renderHostSelector() {
  const selector=$('host-selector');selector.replaceChildren();
  for(const member of room?.members||[]) {const option=document.createElement('option');option.value=member.id;option.textContent=member.name+(member.id===session?.id?' · ты':'');selector.append(option);}
  selector.value=room?.host||'';selector.disabled=!host()||!connected;
}
async function transferHost(id) {
  if(!host()||!id||id===room.host)return;
  $('host-selector').disabled=true;
  try{await command('host',{id});}catch(error){toast(error.message);renderHostSelector();}
}
function access(){for(const key of ['play','back','seek'])$(key).disabled=!host()||!version||!connected;for(const key of ['pick','replace'])$(key).disabled=!host()||!connected||!!upload;$('pick').hidden=!host();$('empty-copy').textContent=host()?'Выбери видео с компьютера. Мы соберём всех перед одним экраном.':'Ведущий выбирает видео. Пока можно включить микрофон и поздороваться.';$('sync-status').textContent=host()?'Ты ведущий · управляй общим плеером':'Синхронизировано с ведущим';}
function state(next){const previousHost=room?.host;room=next;$('count').textContent=room.members.length;$('room-label').textContent='Комната · '+session.room.slice(0,6);if(room.video?.version!==version){destroyStreamPlayer();streamCatalog=null;currentStream='original';sourceResume=null;bufferPausePosition=null;peerBufferOverride=false;version=room.video?.version||null;playbackIntent=false;bufferHolding=false;autoplayBlocked=false;if(version){movie.src=endpoint('video')+`?token=${encodeURIComponent(session.token)}&v=${encodeURIComponent(version)}`;$('screen').classList.add('has-video');$('empty').hidden=true;$('movie-name').textContent=room.video.name;$('movie-detail').textContent=`${(room.video.size/1024**2).toFixed(0)} МБ · общий файл для всей комнаты`;movie.preload='auto';movie.load();showQualities(null);pollStreams();}else{movie.removeAttribute('src');movie.load();$('screen').classList.remove('has-video');$('empty').hidden=false;}}pending=room.playback;updateHostRole(previousHost);apply(pending,previousHost!==room.host);renderPeople();renderMessages();access();renderHostSelector();updateTime();updateBufferDisplay();const ids=new Set(room.members.map(m=>m.id));for(const [key,peer]of peers)if(!ids.has(key)){peer.pc.close();peers.delete(key);}for(const member of room.members)if(member.id!==session.id&&!peers.has(member.id))makePeer(member.id);}
function attach(id, stream) {
  const card = cards.get(id);
  if (!card || !stream) return;
  const video = card.querySelector('video');
  const videoTracks = stream.getVideoTracks().filter(track => track.readyState === 'live');
  const videoKey = videoTracks.map(track => track.id).join(',');
  // Keep camera playback inaudible so browser autoplay policies cannot block it.
  video.muted = true;
  if (video.dataset.tracks !== videoKey) {
    video.dataset.tracks = videoKey;
    video.srcObject = new MediaStream(videoTracks);
  }
  video.hidden = !videoTracks.some(track => track.enabled && !track.muted);
  if (videoTracks.length) video.play().catch(() => {});
  if (id !== session.id) {
    let audio = card.querySelector('audio');
    if (!audio) {audio = document.createElement('audio');audio.autoplay = true;card.append(audio);}
    const audioTracks = stream.getAudioTracks().filter(track => track.readyState === 'live');
    const audioKey = audioTracks.map(track => track.id).join(',');
    if (audio.dataset.tracks !== audioKey) {
      audio.dataset.tracks = audioKey;
      audio.srcObject = new MediaStream(audioTracks);
    }
    if (audioTracks.length) audio.play().catch(() => {$('enable-audio').hidden = false;});
  }
}
function summarizeCandidate(candidate) {
  const parts = String(candidate.candidate || '').split(' ');
  const typeIndex = parts.indexOf('typ');
  return {type:candidate.type || parts[typeIndex + 1] || 'unknown',protocol:candidate.protocol || parts[2]?.toLowerCase() || 'unknown'};
}
async function connectionReport() {
  const report = {
    version:'rtc-diagnostics-1',
    at:new Date().toISOString(),
    name:room?.members.find(member => member.id === session?.id)?.name || '',
    secureContext:window.isSecureContext,
    signaling:connected,
    player:{quality:qualityPreference,mode:currentStream,readyState:movie.readyState,networkState:movie.networkState,position:movie.currentTime,duration:Number.isFinite(movie.duration)?movie.duration:null,bufferAhead:bufferedAhead(movie),error:movie.error?{code:movie.error.code,message:movie.error.message}:null},
    localDevices:media.getTracks().map(track => ({kind:track.kind,enabled:track.enabled,muted:track.muted,state:track.readyState})),
    peers:[]
  };
  for (const [id,peer] of peers) {
    const entry = {
      name:room?.members.find(member => member.id === id)?.name || 'Участник',
      connection:peer.pc.connectionState,ice:peer.pc.iceConnectionState,gathering:peer.pc.iceGatheringState,
      signaling:peer.pc.signalingState,ready:peer.ready,
      localDescription:peer.pc.localDescription?.type || null,remoteDescription:peer.pc.remoteDescription?.type || null,
      localCandidates:peer.localCandidates,remoteCandidates:peer.remoteCandidates,
      iceErrors:peer.iceErrors,signalErrors:peer.signalErrors,
      transports:[],media:[],candidatePairs:[]
    };
    try {
      const stats = await peer.pc.getStats();
      stats.forEach(item => {
        if (item.type === 'transport') entry.transports.push({dtls:item.dtlsState,ice:item.iceState});
        if (item.type === 'inbound-rtp' || item.type === 'outbound-rtp') entry.media.push({direction:item.type,kind:item.kind || item.mediaType,bytesReceived:item.bytesReceived,bytesSent:item.bytesSent,packetsReceived:item.packetsReceived,packetsSent:item.packetsSent,framesDecoded:item.framesDecoded,framesEncoded:item.framesEncoded});
        if (item.type === 'candidate-pair') {
          const local = stats.get(item.localCandidateId),remote = stats.get(item.remoteCandidateId);
          entry.candidatePairs.push({state:item.state,nominated:item.nominated,requestsSent:item.requestsSent,responsesReceived:item.responsesReceived,requestsReceived:item.requestsReceived,responsesSent:item.responsesSent,localType:local?.candidateType,localProtocol:local?.protocol,remoteType:remote?.candidateType,remoteProtocol:remote?.protocol});
        }
      });
    } catch (error) {entry.statsError=error.message;}
    report.peers.push(entry);
  }
  return JSON.stringify(report,null,2);
}
function peerStatus(id, text) {
  const card = cards.get(id);
  if (!card) return;
  let label = card.querySelector('.peer-status');
  if (!label) {label = document.createElement('span');label.className = 'peer-status';card.append(label);}
  label.textContent = text;
}
async function refreshPeerStatus(id, peer) {
  if (peers.get(id) !== peer) return;
  const state = peer.pc.connectionState;
  if (state === 'failed') {
    peerStatus(id, 'Нет прямой связи');
    $('call-note').textContent = 'Не удалось соединить ваши сети. Для связи нужен TURN-сервер; HTTPS-ссылка сама по себе не передаёт камеры.';
    return;
  }
  if (state !== 'connected') {peerStatus(id, state === 'disconnected' ? 'Связь прервалась' : 'Соединяем…');return;}
  try {
    const stats = await peer.pc.getStats();
    let frames = 0;
    stats.forEach(report => {if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) frames += report.framesDecoded || 0;});
    peerStatus(id, frames ? 'Видео приходит' : 'Связь есть · ждём камеру');
  } catch {peerStatus(id, 'Связь есть');}
}

function renderPeople(){const ids=new Set(room.members.map(m=>m.id));for(const [id,card]of cards)if(!ids.has(id)){card.remove();cards.delete(id);}if(!cards.size)$('people').replaceChildren();for(const member of room.members){let card=cards.get(member.id);if(!card){card=document.createElement('div');card.className='person';const avatar=document.createElement('span');avatar.className='avatar';const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.hidden=true;video.muted=member.id===session.id;if(video.muted)video.className='self';const name=document.createElement('span');name.className='person-name';const badge=document.createElement('span');badge.className='host-badge';badge.textContent='ВЕДУЩИЙ';const give=document.createElement('button');give.className='give-host';give.textContent='♔';give.title='Передать управление';give.onclick=()=>transferHost(member.id);const timestamp=document.createElement('span');timestamp.className='person-time';timestamp.setAttribute('aria-label','Позиция просмотра');card.append(avatar,video,name,badge,give,timestamp);cards.set(member.id,card);$('people').append(card);}card.querySelector('.avatar').textContent=member.name.slice(0,2).toUpperCase();card.querySelector('.person-name').textContent=member.name+(member.id===session.id?' · ты':'');card.querySelector('.host-badge').hidden=room.host!==member.id;card.querySelector('.give-host').hidden=!host()||member.id===session.id;attach(member.id,member.id===session.id?media:peers.get(member.id)?.stream);updateParticipantTime(member.id);}}
function updateParticipantTime(id) {
  const label=cards.get(id)?.querySelector('.person-time');
  if(!label)return;
  if(!version){label.textContent='Видео не выбрано';return;}
  const value=id===session?.id?{version,position:movie.currentTime||0,paused:movie.paused,waiting:movie.readyState<3,receivedAt:Date.now()}:watchPositions.get(id);
  if(!value || Date.now()-value.receivedAt>10000){label.textContent='— · нет данных';return;}
  if(value.version!==version){label.textContent='Ждёт видео';return;}
  label.textContent=time(value.position)+' · '+(value.waiting?'загрузка':value.paused?'пауза':'смотрит');
}
async function shareWatchPosition() {
  if(!session||!room||!connected)return;
  const watch={version,position:movie.currentTime||0,paused:movie.paused,waiting:movie.readyState<3||movie.seeking||bufferHolding,buffering:bufferHolding,bufferAhead:bufferedAhead(movie),readyToPlay:bufferReady(movie),bufferReason:host()&&bufferHolding?bufferWaiters().map(waiter=>waiter.name+': '+waiter.reason).join('; '):''};
  const others=room.members.filter(member=>member.id!==session.id);
  await Promise.allSettled(others.map(member=>command('signal',{to:member.id,signal:{watch}})));
  if(!room||!session)return;
  for(const member of room.members)updateParticipantTime(member.id);
}
async function leaveRoom() {
  if(!session)return;
  isScrubbing=false;const old=session;forgetSession(old.room);
  const leaveUrl=endpoint('leave');
  upload?.abort();
  events?.close();events=null;
  connected=false;session=null;room=null;version=null;pending=null;playbackIntent=false;bufferHolding=false;autoplayBlocked=false;
  for(const peer of peers.values())peer.pc.close();peers.clear();
  for(const track of media.getTracks()){track.stop();media.removeTrack(track);}
  destroyStreamPlayer();streamCatalog=null;currentStream='original';sourceResume=null;movie.pause();movie.removeAttribute('src');movie.load();
  for(const card of cards.values()){for(const element of card.querySelectorAll('video,audio'))element.srcObject=null;card.remove();}
  cards.clear();watchPositions.clear();
  $('screen').classList.remove('has-video');$('empty').hidden=false;$('enable-play').hidden=true;
  $('count').textContent='0';$('connection').textContent='НЕ В СЕТИ';$('room-label').textContent='Личная комната';
  $('movie-name').textContent='Твой следующий любимый фильм';$('movie-detail').textContent='Добавь видео, а мы позаботимся о синхронизации';
  $('people').replaceChildren();$('messages').replaceChildren();$('chat-input').value='';
  $('invite').disabled=true;$('leave-room').hidden=true;$('enable-audio').hidden=true;
  for(const key of ['mic','camera','chat-input','send'])$(key).disabled=true;
  for(const key of ['mic','camera']){$(key).classList.remove('on');$(key).querySelector('i').textContent='выкл.';$(key).setAttribute('aria-pressed','false');}
  $('call-note').textContent='Ты вышел из комнаты. Камера и микрофон выключены.';
  requestedRoom=null;history.replaceState(null,'','/');
  $('welcome-title').textContent='Твой вечер начинается здесь.';$('welcome-copy').textContent='Ты вышел из комнаты. Можно создать новую или зайти снова по приглашению.';$('join-button').textContent='Создать комнату ↗';
  access();updateTime();$('welcome').showModal();
  try {
    const response=await fetch(leaveUrl,{method:'POST',headers:{Authorization:'Bearer '+old.token},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error();
  }catch{toast('Ты вышел. Сервер удалит подключение после истечения тайм-аута.');}
}
setInterval(shareWatchPosition,2000);
movie.addEventListener('timeupdate',()=>{if(session)updateParticipantTime(session.id);});
for(const event of ['play','pause','seeked','loadedmetadata','waiting','playing'])movie.addEventListener(event,shareWatchPosition);
function addMessage(message){$('messages').querySelector('.chat-welcome')?.remove();const item=document.createElement('div');item.className='message'+(message.from===session.id?' own':'');const author=document.createElement('div');author.className='message-author';author.textContent=message.name;const timestamp=document.createElement('time');timestamp.textContent=new Date(message.at).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});author.append(timestamp);const text=document.createElement('div');text.className='message-text';text.textContent=message.text;item.append(author,text);$('messages').append(item);$('messages').scrollTop=$('messages').scrollHeight;}
function renderMessages(){$('messages').replaceChildren();if(!room.messages.length){const intro=document.createElement('div');intro.className='chat-welcome';intro.textContent='✳ Здесь можно обсуждать всё. Но лучше без спойлеров.';$('messages').append(intro);}for(const message of room.messages)addMessage(message);}
function connect(){events?.close();events=new EventSource(endpoint('events')+'?token='+encodeURIComponent(session.token));events.onopen=()=>{connected=true;$('connection').textContent='В СЕТИ';access();renderHostSelector();};events.onerror=()=>{connected=false;$('connection').textContent='ПЕРЕПОДКЛЮЧЕНИЕ';access();};events.addEventListener('state',e=>state(JSON.parse(e.data)));events.addEventListener('playback',e=>{const data=JSON.parse(e.data);if(data.version===version){room.playback=data;apply(data);}});events.addEventListener('chat',e=>{const message=JSON.parse(e.data);room.messages.push(message);room.messages=room.messages.slice(-80);addMessage(message);});events.addEventListener('signal',async e=>{const data=JSON.parse(e.data);try{await signal(data.from,data.signal);}catch(error){console.warn('WebRTC',error);$('call-note').textContent='Связь не установилась. Для некоторых сетей нужен TURN-сервер.';}});}
function savedSession(roomId) {try{return JSON.parse(sessionStorage.getItem('together-session:'+roomId)||'null');}catch{return null;}}
function rememberSession(value,name){try{sessionStorage.setItem('together-session:'+value.room,JSON.stringify({...value,name}));}catch{}}
function forgetSession(roomId){try{sessionStorage.removeItem('together-session:'+roomId);}catch{}}
async function enter(e){
  e.preventDefault();if(joining)return;joining=true;$('join-button').disabled=true;
  try {
    const old=requestedRoom?savedSession(requestedRoom):null;
    const name=($('name').value||old?.name||'').trim();if(!name)throw new Error('Введи своё имя');
    try{localStorage.setItem('together-name',name);}catch{}
    config=await fetch('/api/config').then(r=>r.json());config.iceServers=[...(config.iceServers||[]),{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun1.l.google.com:19302'}];
    if(requestedRoom){
      const joinUrl='/api/rooms/'+encodeURIComponent(requestedRoom)+'/join';
      try{session=await api(joinUrl,{name,...(old?.token?{token:old.token}:{})},false);}
      catch(error){if(error.status!==401||!old)throw error;forgetSession(requestedRoom);session=await api(joinUrl,{name},false);}
    }else session=await api('/api/rooms',{name},false);
    rememberSession(session,name);requestedRoom=session.room;history.replaceState(null,'','?room='+session.room);
    $('new-room').hidden=true;$('welcome').close();$('invite').disabled=false;$('leave-room').hidden=false;
    for(const key of ['mic','camera','chat-input','send'])$(key).disabled=false;
    connect();if(!navigator.mediaDevices)$('call-note').textContent='Камера и микрофон доступны через HTTPS или localhost.';
  }catch(error){
    toast(error.message);
    if(error.status===404){$('welcome-title').textContent='Эта комната недоступна';$('welcome-copy').textContent='Ссылка сохранена. Попроси ведущего проверить комнату или вернись на главную, чтобы создать новую.';$('join-button').textContent='Повторить вход';$('new-room').hidden=false;}
  }finally{joining=false;$('join-button').disabled=false;}
}

function makePeer(id) {
  const pc = new RTCPeerConnection({iceServers:config.iceServers});
  const stream = new MediaStream();
  const initiator = session.id < id;
  const peer = {pc,stream,initiator,makingOffer:false,ignoreOffer:false,settingAnswer:false,polite:!initiator,candidates:[],signalQueue:Promise.resolve(),restarted:false,ready:false,helloAnswered:false,localCandidates:[],remoteCandidates:[],iceErrors:[],signalErrors:[]};
  peers.set(id, peer);
  // Only the caller creates transceivers. The answerer reuses those from the offer.
  if (initiator) for (const kind of ['audio','video']) {
    const track = media.getTracks().find(t => t.kind === kind && t.readyState === 'live');
    pc.addTransceiver(track || kind, {direction:'sendrecv',streams:[media]});
  }
  pc.onicecandidate = event => {
    if (event.candidate) {peer.localCandidates.push(summarizeCandidate(event.candidate));command('signal',{to:id,signal:{candidate:event.candidate}}).catch(error => peer.signalErrors.push(error.message));}
  };
  pc.onicecandidateerror = event => {peer.iceErrors.push({code:event.errorCode,message:event.errorText,url:event.url});};
  pc.ontrack = event => {
    if (!stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
    event.track.onunmute = () => attach(id,stream);
    event.track.onmute = () => attach(id,stream);
    event.track.onended = () => {stream.removeTrack(event.track);attach(id,stream);};
    attach(id,stream);
  };
  pc.onnegotiationneeded = async () => {
    if (!peer.ready || (!initiator && !pc.remoteDescription) || pc.signalingState !== 'stable' || peer.makingOffer) return;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      await command('signal',{to:id,signal:{description:pc.localDescription}});
    } catch (error) {console.warn('Согласование звонка',error);}
    finally {peer.makingOffer = false;}
  };
  pc.onconnectionstatechange = () => {
    refreshPeerStatus(id,peer);
    if (pc.connectionState === 'failed' && initiator && !peer.restarted) {peer.restarted = true;pc.restartIce();}
  };
  refreshPeerStatus(id,peer);
  command('signal',{to:id,signal:{hello:true}}).catch(() => {});
  return peer;
}
function signal(from, input) {
  if (input.watch) {
    const value=input.watch;
    if (typeof value.position==='number' && Number.isFinite(value.position) && value.position>=0) {
      watchPositions.set(from,{...value,receivedAt:Date.now()});
      updateParticipantTime(from);
    }
    return Promise.resolve();
  }
  const peer = peers.get(from) || makePeer(from);
  // Description changes and ICE candidates must be applied in arrival order.
  const operation = peer.signalQueue.then(() => applySignal(from,peer,input));
  peer.signalQueue = operation.catch(error => {peer.signalErrors.push(error.message);});
  return operation;
}
async function applySignal(from, peer, input) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  if (input.hello) {
    peer.ready = true;
    if (!peer.helloAnswered) {peer.helloAnswered = true;await command('signal',{to:from,signal:{hello:true}});}
    if (peer.initiator && !pc.localDescription && !peer.makingOffer) await pc.onnegotiationneeded();
    return;
  }
  if (input.description) {
    const description = input.description;
    const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
    const collision = description.type === 'offer' && !ready;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    peer.settingAnswer = description.type === 'answer';
    try {await pc.setRemoteDescription(description);} finally {peer.settingAnswer = false;}
    for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (description.type === 'offer') {
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.stopped) continue;
        transceiver.direction = 'sendrecv';
        const track = media.getTracks().find(t => t.kind === transceiver.receiver.track.kind && t.readyState === 'live');
        transceiver.sender.setStreams?.(media);
        await transceiver.sender.replaceTrack(track || null);
      }
      await pc.setLocalDescription();
      await command('signal',{to:from,signal:{description:pc.localDescription}});
    }
  } else if (input.candidate) {
    peer.remoteCandidates.push(summarizeCandidate(input.candidate));
    if (peer.ignoreOffer) return;
    if (pc.remoteDescription) await pc.addIceCandidate(input.candidate);
    else peer.candidates.push(input.candidate);
  }
}
setInterval(() => {for (const [id,peer] of peers) refreshPeerStatus(id,peer);}, 5000);

function deviceError(error, kind) {
  const device = kind === 'video' ? 'камере' : 'микрофону';
  const messages = {
    NotAllowedError: `Нет доступа к ${device}. Разреши доступ в настройках сайта. Если сайт открыт внутри Codex, попробуй ту же ссылку в Chrome или Firefox.`,
    PermissionDeniedError: `Браузер запретил доступ к ${device}. Проверь разрешения сайта.`,
    NotFoundError: kind === 'video' ? 'Камера не найдена. Проверь подключение вебки.' : 'Микрофон не найден. Проверь подключение устройства.',
    DevicesNotFoundError: 'Браузер не нашёл нужное устройство.',
    NotReadableError: 'Браузер не смог запустить устройство. Закрой приложения, использующие камеру или микрофон, и попробуй снова. Во встроенном браузере попробуй открыть ссылку в Chrome.',
    TrackStartError: 'Устройство занято или недоступно. Закрой другие приложения с камерой и попробуй снова.',
    OverconstrainedError: 'Камера не поддерживает запрошенные настройки.',
    SecurityError: 'Этот браузер запрещает доступ к устройству. Открой HTTPS-ссылку в обычном Chrome или Firefox.',
    AbortError: 'Запуск устройства прервался. Попробуй включить его ещё раз.',
    TypeError: 'Захват камеры или микрофона недоступен в этом браузере. Открой HTTPS-ссылку в Chrome или Firefox.'
  };
  return (messages[error.name] || 'Не удалось включить устройство: ' + error.message) + ' [' + (error.name || 'Error') + ']';
}
async function sendTrack(kind, track) {
  const active = [...peers.values()].filter(peer => peer.pc.signalingState !== 'closed');
  const results = await Promise.allSettled(active.map(async peer => {
    const transceiver = peer.pc.getTransceivers().find(t => !t.stopped && t.receiver.track.kind === kind);
    if (transceiver) await transceiver.sender.replaceTrack(track);
    else if (track) peer.pc.addTrack(track, media);
  }));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    console.warn('Отправка медиадорожки:', failed.map(result => result.reason));
    $('call-note').textContent = 'Устройство включено, но передать его одному из участников не удалось. Попробуйте перезайти в комнату.';
  }
}
async function toggle(kind) {
  const key = kind === 'audio' ? 'mic' : 'camera';
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = 'Этот браузер не предоставляет доступ к камере и микрофону. Открой HTTPS-ссылку в Chrome или Firefox.';
    $('call-note').textContent = message; toast(message); return;
  }
  $(key).disabled = true;
  try {
    for (const ended of media.getTracks().filter(t => t.readyState === 'ended')) media.removeTrack(ended);
    let track = media.getTracks().find(t => t.kind === kind);
    if (track) {
      track.enabled = !track.enabled;
      if (!track.enabled && kind === 'video') {
        media.removeTrack(track);
        track.stop();
        updateDevices();
        await sendTrack(kind, null);
      }
    } else {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(kind === 'audio'
          ? {audio:{echoCancellation:true,noiseSuppression:true},video:false}
          : {audio:false,video:{width:{ideal:640},height:{ideal:360},frameRate:{ideal:20,max:30}}});
      } catch (error) {
        if (kind !== 'video' || error.name !== 'OverconstrainedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({audio:false,video:true});
      }
      track = stream.getTracks().find(t => t.kind === kind);
      if (!track) throw new DOMException('Браузер не вернул медиадорожку', 'NotFoundError');
      media.addTrack(track);
      track.onended = () => {media.removeTrack(track);updateDevices();sendTrack(kind,null);};
      updateDevices();
      $('call-note').textContent = 'Устройство включено · лучше слушать в наушниках';
      await sendTrack(kind, track);
    }
    updateDevices();
  } catch (error) {
    const message = deviceError(error, kind);
    $('call-note').textContent = message;
    toast(message);
    updateDevices();
  } finally { $(key).disabled = false; }
}
function updateDevices(){for(const [kind,key]of [['audio','mic'],['video','camera']]){const on=media.getTracks().some(t=>t.kind===kind&&t.enabled&&t.readyState==='live');$(key).classList.toggle('on',on);$(key).querySelector('i').textContent=on?'вкл.':'выкл.';$(key).setAttribute('aria-pressed',String(on));}attach(session.id,media);}
function uploadFile(file){if(!host()||upload||!file)return;if(file.size>config.maxBytes){toast(`Максимальный размер — ${Math.round(config.maxBytes/1024**3)} ГБ`);return;}if(!file.size){toast('Файл пустой');return;}const xhr=new XMLHttpRequest();upload=xhr;access();$('upload-panel').hidden=false;$('upload-name').textContent=file.name;$('upload-progress').style.width='0%';$('upload-status').textContent='Загружаем видео в комнату…';xhr.open('POST',endpoint('upload'));xhr.setRequestHeader('Authorization','Bearer '+session.token);xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=e=>{const percentage=Math.round(e.loaded/file.size*100);$('upload-progress').style.width=percentage+'%';$('upload-status').textContent=percentage===100?'Обрабатываем файл…':`Загружаем · ${percentage}%`;};xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)toast('Видео готово. Можно начинать вечер!');else{let text='Не удалось загрузить видео';try{text=JSON.parse(xhr.responseText).error||text;}catch{}toast(text);}};xhr.onerror=()=>toast('Соединение прервалось. Попробуй загрузить файл заново.');xhr.onabort=()=>toast('Загрузка отменена');xhr.onloadend=()=>{upload=null;$('upload-panel').hidden=true;$('file').value='';access();};xhr.send(file);}
$('diagnostics').ontoggle=async()=>{if($('diagnostics').open)$('diagnostics-output').value=await connectionReport();};
$('copy-diagnostics').onclick=async()=>{const report=await connectionReport();$('diagnostics-output').value=report;try{await navigator.clipboard.writeText(report);toast('Диагностика скопирована. Отправь её в чат.');}catch{$('diagnostics-output').select();toast('Нажми Ctrl+C, чтобы скопировать отчёт');}};
$('new-room').onclick=()=>{if(requestedRoom)forgetSession(requestedRoom);requestedRoom=null;history.replaceState(null,'','/');$('welcome-title').textContent='Твой вечер начинается здесь.';$('welcome-copy').textContent='Создай комнату и отправь друзьям новую ссылку.';$('join-button').textContent='Создать комнату ↗';$('new-room').hidden=true;};
$('host-selector').onchange=()=>transferHost($('host-selector').value);
$('leave-room').onclick=leaveRoom;
$('join-form').onsubmit=enter;try{$('name').value=localStorage.getItem('together-name')||'';}catch{}
if(requestedRoom){$('welcome-title').textContent='Тебя уже ждут.';$('welcome-copy').textContent='Зайди в комнату и устройтесь поудобнее. Фильм лучше смотреть вместе.';$('join-button').textContent='Присоединиться ↗';}$('welcome').addEventListener('cancel',e=>e.preventDefault());$('welcome').showModal();if(requestedRoom&&savedSession(requestedRoom))enter({preventDefault(){}});
$('invite').onclick=async()=>{const link=location.origin+'/?room='+session.room;try{await navigator.clipboard.writeText(link);toast(location.hostname==='localhost'?'Ссылка скопирована. Друзьям нужен внешний адрес сервера вместо localhost.':'Ссылка скопирована. Отправь её друзьям!');}catch{prompt('Скопируй ссылку на комнату',link);}};
$('pick').onclick=$('replace').onclick=()=>$('file').click();$('file').onchange=()=>uploadFile($('file').files[0]);$('cancel-upload').onclick=()=>upload?.abort();$('screen').ondragover=e=>e.preventDefault();$('screen').ondrop=e=>{e.preventDefault();uploadFile(e.dataTransfer.files[0]);};
$('play').onclick=requestPlayPause;$('back').onclick=()=>seekTo(movie.currentTime-10);$('seek').onpointerdown=()=>{isScrubbing=host();};
$('seek').oninput=()=>{isScrubbing=true;updateTime();};
$('seek').onchange=()=>{const position=Number($('seek').value);isScrubbing=false;seekTo(position);};
$('seek').onblur=()=>{isScrubbing=false;updateTime();};
$('seek').onpointercancel=()=>{isScrubbing=false;updateTime();};
window.addEventListener('pointerup',()=>{isScrubbing=false;});
for(const event of ['play','pause','seeked','ended'])movie.addEventListener(event,()=>{if(host()&&movie.controls&&!bufferHolding){if(event==='play')playbackIntent=true;if(event==='pause'||event==='ended')playbackIntent=false;}if(event==='ended'){playbackIntent=false;bufferHolding=false;}updateTime();publish();});movie.addEventListener('timeupdate',updateTime);movie.addEventListener('loadedmetadata',()=>{updateTime();if(sourceResume){const resume=sourceResume;sourceResume=null;movie.currentTime=Math.min(resume.position,Math.max(0,(movie.duration||resume.position)-0.01));if(host()&&resume.shouldPlay){playbackIntent=true;bufferHolding=true;checkPlaybackBuffer();}else if(resume.shouldPlay)movie.play().catch(()=>{$('enable-play').hidden=false;});}else if(pending)apply(pending,true);});movie.addEventListener('error',()=>{if(version)toast('Браузер не смог открыть файл. Попробуй MP4 с кодеками H.264 + AAC или WebM.');});
$('enable-play').onclick=()=>{autoplayBlocked=false;return movie.play().then(()=>{$('enable-play').hidden=true;for(const card of cards.values())card.querySelector('video').play().catch(()=>{});}).catch(()=>toast('Не удалось воспроизвести видео'));};
$('mute').onclick=()=>{movie.muted=!movie.muted;$('mute').textContent=movie.muted?'⊘':'♪';};$('volume').oninput=()=>{movie.volume=Number($('volume').value);movie.muted=false;$('mute').textContent='♪';};$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('player').requestFullscreen();}catch{toast('Полный экран недоступен в этом браузере');}};
document.addEventListener('fullscreenchange',()=>{movie.controls=false;$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Выйти из полного экрана':'Полный экран');});
$('continue-buffer').onclick=()=>{peerBufferOverride=true;checkPlaybackBuffer();};
$('quality').onchange=()=>{qualityPreference=$('quality').value;useQuality(qualityPreference);};
movie.ondblclick=()=>$('fullscreen').click();
$('enable-audio').onclick=async()=>{const results=await Promise.allSettled([...cards.values()].flatMap(card=>[...card.querySelectorAll('audio')]).map(audio=>audio.play()));$('enable-audio').hidden=results.every(result=>result.status==='fulfilled');};
$('mic').onclick=()=>toggle('audio');$('camera').onclick=()=>toggle('video');$('chat-form').onsubmit=async e=>{e.preventDefault();const input=$('chat-input'),text=input.value.trim();if(!text)return;input.value='';try{await command('chat',{text});}catch(error){input.value=text;toast(error.message);}};
window.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)||$('welcome').open)return;if(e.code==='Space'&&host()&&version){e.preventDefault();$('play').click();}if(e.code==='ArrowRight'&&host()&&version)seekTo(movie.currentTime+10);if(e.code==='ArrowLeft'&&host()&&version)$('back').click();});
window.addEventListener('beforeunload',()=>{if(!session)return;events?.close();for(const track of media.getTracks())track.stop();// Reload keeps the session; only the explicit Exit button removes membership.
});
setInterval(()=>{if(!room||!version)return;if(host()&&!movie.paused)publish();else if(!host()&&connected&&pending)apply(pending);},4000);
