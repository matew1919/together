'use strict';
const $=id=>document.getElementById(id),movie=$('movie'),peers=new Map(),cards=new Map(),media=new MediaStream();
let session,room,config,events,version,upload,toastTimer,connected=false,joining=false;
let requestedRoom=new URLSearchParams(location.search).get('room');
const watchPositions=new Map();
let isScrubbing=false;
let autoplayBlocked=false,unlocking=false,playAttempt=null,startTimer,clockOffset=0;
let playbackWrite=Promise.resolve(),pendingSeek,watchTimer,watchBusy=false,watchAgain=false;
let reconnectTimer,reconnectReason,lastRoomEvent,heldPlayback,mediaWaiting=false,mediaRetry,mediaRetryCount=0,mediaSource;
let streamPlayer=null,streamCatalog=null,currentStream=null,playedVersion,qualityPreference='auto',streamWatchdog,sourceLoading=false,sourceFailed=false;
const screenCards=new Map();
let displayCapture=null,callView=false,focusedTile=null,callMuted=false;
let micTestUrl,micTestTrack;
let participantsOpen=false,expandedScreen=null,screenReturn=null;
let cameraWindow=null,cameraWindowGrid=null,cameraWindowOpening=false;
const cameraWindowCards=new Map();
let libraryBusy=false,fullscreenTimer,hlsLoading=false,hlsUnavailable=false;
const libraryKey=getLibraryKey();
const playbackIntent=()=>!!room&&room.playback.phase!=='paused';
const host=()=>!!session&&!!room&&room.host===session.id;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
const endpoint=action=>`/api/rooms/${encodeURIComponent(session.room)}/${action}`;
async function api(url,data,auth=true) {
  const current=auth?session:null;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(current?{Authorization:'Bearer '+current.token,'X-Library-Key':libraryKey}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
  if(!response.ok) {
    if(response.status===401&&current&&session===current)location.reload();
    const body=await response.json().catch(()=>null);
    const error=new Error(body?.error||'Ошибка сервера ('+response.status+')');
    error.status=response.status;
    throw error;
  }
  return response.json();
}
const command=(action,data)=>api(endpoint(action),data);
function time(seconds){seconds=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));return (seconds>=3600?Math.floor(seconds/3600)+':':'')+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
function updateTime(){
  const duration=Number.isFinite(movie.duration)?movie.duration:streamCatalog?.duration||0;
  const playback=room?.playback;
  const showingTarget=playback&&(playback.phase!=='playing'||sourceLoading||movie.seeking||movie.readyState<2||movie.paused);
  const position=isScrubbing?Number($('seek').value):showingTarget
    ?Math.min(duration||Infinity,targetPosition()):movie.currentTime||0;
  $('time').replaceChildren(document.createTextNode(time(position)+' '));
  const span=document.createElement('span');span.textContent='/ '+time(duration);$('time').append(span);
  $('seek').max=duration||100;
  if(!isScrubbing)$('seek').value=position;
  const active=host()?playbackIntent():!movie.paused;
  $('play').textContent=active?'Ⅱ':'▶';$('play').setAttribute('aria-label',active?'Пауза':'Воспроизвести');
  $('played-track').style.width=(duration?Math.min(100,position/duration*100):0)+'%';
}

function destroyStreamPlayer() {
  clearTimeout(streamWatchdog);
  streamPlayer?.destroy();
  streamPlayer=null;
}
function mediaUrl(action) {
  return endpoint(action)+'?token='+encodeURIComponent(session.token);
}
function originalVideoUrl(){return mediaUrl('video')+'&v='+encodeURIComponent(version);}
function showQualities(catalog) {
  const select=$('quality'),chosen=qualityPreference;
  select.replaceChildren(new Option('Авто','auto'));
  if(!room?.video?.live)select.append(new Option('Оригинал','original'));
  for(const variant of catalog?.variants||[]) {
    if(variant.id==='source')continue;
    const status=variant.ready?'':variant.failed?' · недоступно':variant.requested?' · готовится':' · по запросу';
    const option=new Option(variant.height+'p'+status,variant.id);
    option.disabled=variant.failed;
    select.append(option);
  }
  select.value=[...select.options].some(option=>option.value===chosen)?chosen:'auto';
}
function changeSource(target,url,hlsSource) {
  const position=targetPosition();
  clearTimeout(mediaRetry);mediaRetry=null;
  if(mediaSource?.target!==target||mediaSource?.version!==version)mediaRetryCount=0;
  mediaSource={version,target,url,hlsSource};
  sourceLoading=true;
  sourceFailed=false;
  mediaWaiting=true;
  playAttempt=null;
  movie.pause();
  destroyStreamPlayer();
  currentStream=target;
  movie.preload='auto';
  scheduleWatch();
  if(!hlsSource||typeof Hls==='undefined'||!Hls.isSupported()) {
    movie.src=url;
    movie.load();
    return;
  }
  const hls=new Hls({
    enableWorker:true,maxBufferLength:120,maxMaxBufferLength:120,maxBufferSize:96*1024*1024,
    backBufferLength:30,startPosition:position,startLevel:0,
    capLevelToPlayerSize:target.startsWith('auto:'),abrEwmaDefaultEstimate:700000,
    abrBandWidthFactor:0.75,abrBandWidthUpFactor:0.55
  });
  streamPlayer=hls;
  let recoveries=0;
  const fallback=()=>{
    if(streamPlayer!==hls||!version)return;
    if(room?.video?.live){retryMedia();return;}
    toast('Не удалось открыть поток. Загружаю исходный файл.');
    qualityPreference='original';
    showQualities(streamCatalog);
    changeSource('original',originalVideoUrl(),false);
  };
  hls.on(Hls.Events.ERROR,(_,data)=>{
    if(streamPlayer!==hls||!data.fatal)return;
    if(++recoveries>2){if(data.type===Hls.ErrorTypes.NETWORK_ERROR)retryMedia();else fallback();return;}
    if(data.type===Hls.ErrorTypes.NETWORK_ERROR) {
      if(!hls.levels.length)hls.loadSource(url);
      else hls.startLoad(targetPosition());
    } else if(data.type===Hls.ErrorTypes.MEDIA_ERROR)hls.recoverMediaError();
    else fallback();
  });
  hls.on(Hls.Events.FRAG_BUFFERED,(_,data)=>{
    if(streamPlayer===hls&&typeof data.frag.sn==='number')clearTimeout(streamWatchdog);
  });
  hls.on(Hls.Events.MEDIA_ATTACHED,()=>hls.loadSource(url));
  hls.attachMedia(movie);
  streamWatchdog=setTimeout(()=>{if(movie.readyState<2)retryMedia();},20000);
}
function retryMedia() {
  if(mediaRetry||!mediaSource||mediaSource.version!==version)return;
  const source=mediaSource;
  sourceLoading=true;
  mediaWaiting=true;
  movie.pause();
  scheduleWatch();
  mediaRetry=setTimeout(()=>{
    mediaRetry=null;
    if(mediaSource===source&&version===source.version)changeSource(source.target,source.url,source.hlsSource);
  },Math.min(8000,1000*2**mediaRetryCount++));
}
function loadHls() {
  if(hlsLoading)return;
  hlsLoading=true;
  const script=document.createElement('script');
  script.src='/hls.min.js';
  script.onload=()=>useQuality(qualityPreference,true);
  script.onerror=()=>{hlsUnavailable=true;useQuality(qualityPreference,true);};
  document.head.append(script);
}
async function useQuality(choice,automatic=false) {
  if(!session||!version)return;
  if(room?.video?.live&&choice==='original')choice='auto';
  const ready=(streamCatalog?.variants||[]).filter(variant=>variant.ready);
  const optimized=ready.filter(variant=>variant.id!=='source'&&variant.height<=720);
  const variants=choice==='original'?[]:choice==='auto'?(optimized.length?optimized:ready):ready.filter(variant=>variant.id===choice);
  if(!variants.length&&choice!=='original'&&choice!=='auto') {
    if(!automatic) {
      try{await loadCatalog(choice);toast('Готовим '+choice+'p. Пока оставляю текущее качество.');}
      catch{toast('Не удалось запустить подготовку качества');}
    }
    return;
  }
  if(variants.length&&(window.MediaSource||window.ManagedMediaSource)&&typeof Hls==='undefined'&&!hlsUnavailable) {
    loadHls();
    if(!currentStream&&!room.video.live)changeSource('original',originalVideoUrl(),false);
    return;
  }
  const canHls=(typeof Hls!=='undefined'&&Hls.isSupported())||movie.canPlayType('application/vnd.apple.mpegurl');
  const hlsSource=canHls&&variants.length>0;
  const target=hlsSource?(choice==='auto'?'auto:'+variants.map(v=>v.id).join(','):variants[0].id):'original';
  if(target===currentStream)return;
  // An automatic source replacement discards the buffer and resets the media clock.
  if(automatic&&choice==='auto'&&currentStream&&!sourceFailed&&
    (playedVersion===version||room.playback.phase==='playing'))return;
  if(hlsSource) {
    const base='hls/'+encodeURIComponent(version)+'/';
    const manifest=choice==='auto'&&typeof Hls!=='undefined'&&Hls.isSupported()?
      'master.m3u8':variants[0].id+'/index.m3u8';
    changeSource(target,mediaUrl(base+manifest),true);
  } else if(!room.video.live)changeSource(target,originalVideoUrl(),false);
  else if(variants.length){sourceFailed=true;toast('Для этого потока нужен браузер с поддержкой HLS.');}
}
function applyCatalog(catalog,initial=false) {
  if(catalog.version!==version||(catalog.revision||0)<(streamCatalog?.revision||0))return;
  streamCatalog=catalog;
  if(catalog.live){
    room.video.growing=catalog.growing;
    sourceFailed=catalog.status==='failed';
    $('movie-detail').textContent=catalog.growing?'Файл ещё скачивается · 360p':'Скачивание завершено · 360p';
  }
  showQualities(catalog);
  if(initial||currentStream||catalog.variants.some(variant=>variant.ready))useQuality(qualityPreference,true);
  if(sourceFailed&&catalog.status==='failed')toast('Браузер не смог открыть видео. Попробуй MP4 (H.264 + AAC) или WebM.');
}
async function loadCatalog(quality) {
  const query=quality?'?quality='+encodeURIComponent(quality):'';
  const response=await fetch(endpoint('media')+query,{headers:{Authorization:'Bearer '+session.token},signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('Нет данных о качестве');
  applyCatalog(await response.json(),true);
}
function bufferedAhead(video, position=video.currentTime || 0) {
  let end=position;
  for(let i=0;i<video.buffered.length;i++) {
    const start=video.buffered.start(i),rangeEnd=video.buffered.end(i);
    if(start<=end+0.15 && rangeEnd>position)end=Math.max(end,rangeEnd);
  }
  return Math.max(0,end-position);
}
function localTime(){return performance.timeOrigin+performance.now();}
function serverNow(){return localTime()+clockOffset;}
async function syncClock() {
  const samples=await Promise.allSettled(Array.from({length:3},async()=>{
    const sent=localTime();
    const response=await fetch('/api/time',{signal:AbortSignal.timeout(3000)});
    const {now}=await response.json(),received=localTime();
    if(!Number.isFinite(now))throw new Error('Нет времени сервера');
    return {latency:received-sent,offset:now-(sent+received)/2};
  }));
  const best=samples.flatMap(sample=>sample.status==='fulfilled'?[sample.value]:[]).sort((a,b)=>a.latency-b.latency)[0];
  if(best)clockOffset=best.offset;
}
function targetPosition(now=serverNow()) {
  const playback=room?.playback;
  if(!playback)return 0;
  return playback.position+(playback.phase==='playing'?Math.max(0,now-playback.at)/1000:0);
}
function bufferWaiters() {
  const playback=room.playback;
  return room.members.filter(member=>{
    const report=watchPositions.get(member.id);
    return member.present&&(!member.online||!report?.ready||report.sequence!==playback.sequence||Date.now()-report.receivedAt>5500);
  }).map(member=>member.id===session.id?'тебя':member.name);
}
function updateBufferDisplay() {
  const ahead=bufferedAhead(movie);
  $('buffer-health').textContent=version?'Загружено вперёд: '+time(ahead)+(streamPlayer?.bandwidthEstimate?' · '+(streamPlayer.bandwidthEstimate/1000000).toFixed(1)+' Мбит/с':''):'';
  const track=$('buffered-track');
  const duration=Number.isFinite(movie.duration)?movie.duration:streamCatalog?.duration||0;
  track.replaceChildren();
  if(duration>0)for(let i=0;i<movie.buffered.length;i++) {
    const segment=document.createElement('span');
    segment.style.left=(movie.buffered.start(i)/duration*100)+'%';
    segment.style.width=((movie.buffered.end(i)-movie.buffered.start(i))/duration*100)+'%';
    track.append(segment);
  }
  const phase=room?.playback.phase;
  const group=phase==='buffering';
  const localWaiting=sourceLoading||(!movie.ended&&!movie.paused&&(movie.readyState<3||movie.seeking));
  const needsClick=connected&&playbackIntent()&&autoplayBlocked;
  $('enable-play').hidden=!version||!needsClick;
  $('buffer-overlay').hidden=!version||needsClick||(!group&&!localWaiting&&!sourceFailed);
  if(sourceFailed) {
    $('buffer-message').textContent=streamCatalog?.status==='failed'?'Не удалось открыть видео':'Готовим поток для этого файла…';
    $('buffer-description').textContent=streamCatalog?.status==='failed'?(streamCatalog.error||'Выбери другое качество или файл MP4 (H.264 + AAC).'):'';
  } else if(group) {
    const waiting=bufferWaiters();
    $('buffer-message').textContent=waiting.length?'Ждём: '+waiting.join(', '):'Готово. Скоро продолжим…';
    $('buffer-description').textContent='Твой буфер: '+time(ahead);
  } else {
    $('buffer-message').textContent='Подгружаем видео…';
    $('buffer-description').textContent='';
  }
}
function startPlayback() {
  if(autoplayBlocked||playAttempt||!movie.paused||movie.ended||heldPlayback===room?.playback)return;
  const attempt=movie.play();
  playAttempt=attempt;
  attempt.catch(error=>{
    if(playAttempt!==attempt)return;
    if(error.name==='NotAllowedError')autoplayBlocked=true;
  }).finally(()=>{
    if(playAttempt!==attempt)return;
    playAttempt=null;
    updateBufferDisplay();
    scheduleWatch();
  });
}
function syncPlayback(force=false) {
  clearTimeout(startTimer);
  if(!version||!room)return;
  if(sourceLoading||movie.readyState===0||unlocking){updateTime();return;}
  const {phase,at}=room.playback;
  const now=serverNow();
  const delay=at-now;
  const target=Math.min(movie.duration||Infinity,targetPosition(now));
  const playing=connected&&phase==='playing'&&delay<=0;
  if(!playing) {
    if(!movie.paused)movie.pause();
    if(connected&&phase==='playing')startTimer=setTimeout(syncPlayback,delay);
  }
  const drift=Math.abs(movie.currentTime-target);
  if((force||!movie.seeking)&&drift>(force||!playing?0.12:0.35)&&(!playing||force||movie.readyState>=3))movie.currentTime=target;
  if(playing&&!movie.seeking)startPlayback();
  updateTime();
}
function receivePlayback(next) {
  if(!room||next.version!==version||next.sequence<=room.playback.sequence)return;
  room.playback=next;
  syncPlayback(true);
  if(next.phase!=='playing')useQuality(qualityPreference,true);
  updateBufferDisplay();
  scheduleWatch();
}
function writePlayback(action,position,sequence) {
  if(!host()||!version||!connected)return;
  const expectedSession=session,expectedVersion=version;
  return playbackWrite=playbackWrite.catch(()=>{}).then(async()=>{
    if(!host()||session!==expectedSession||version!==expectedVersion)return;
    const playback=await command('playback',{action,position,sequence,version:expectedVersion});
    if(session===expectedSession)receivePlayback(playback);
  }).catch(error=>toast(error.message));
}
function requestPlayPause() {
  if(playbackIntent())writePlayback('pause');
  else writePlayback('play',!room.video?.growing&&(movie.ended||movie.currentTime>=movie.duration-0.08)?0:undefined);
}
function seekTo(position) {
  if(!host()||!version||!connected||!Number.isFinite(position))return;
  const target=Math.max(0,Math.min(Number.isFinite(movie.duration)?movie.duration:position,position));
  const request={session,version,target};
  pendingSeek=request;
  writePlayback('seek',target).finally(()=>{
    if(pendingSeek===request)pendingSeek=null;
  });
}
function seekBy(delta) {
  const base=pendingSeek&&pendingSeek.session===session&&pendingSeek.version===version
    ?pendingSeek.target:targetPosition();
  seekTo(base+delta);
}
function updateHostRole(previousHost) {
  if(previousHost&&room.host!==previousHost&&host())toast('Теперь ты ведущий. Ты управляешь видео в комнате.');
}
function renderHostSelector() {
  const selector=$('host-selector');
  selector.replaceChildren();
  for(const member of room?.members||[])selector.append(new Option(member.name+(member.id===session?.id?' · ты':''),member.id));
  selector.value=room?.host||'';
  selector.disabled=!host()||!connected;
}
async function transferHost(id) {
  if(!host()||!id||id===room.host)return;
  $('host-selector').disabled=true;
  try{await command('host',{id});}catch(error){toast(error.message);renderHostSelector();}
}
function access() {
  for(const key of ['play','back','seek'])$(key).disabled=!host()||!version||!connected;
  for(const key of ['pick','replace'])$(key).disabled=!host()||!connected||!!upload;
  $('pick').hidden=!host();
  $('replace').hidden=!host()||!version;
  $('empty-copy').textContent=host()?'Выбери сохранённое видео или добавь файл с компьютера.':'Ведущий выбирает видео.';
  $('sync-status').textContent=host()?'Ты управляешь плеером':'Плеер синхронизирован с ведущим';
}
function state(next) {
  const previousHost=room?.host,nextVersion=next.video?.version||null,changed=nextVersion!==version;
  if(!changed&&room&&next.playback.sequence<room.playback.sequence) {
    next.playback=room.playback;
  }
  const newPlayback=room?.playback.sequence!==next.playback.sequence;
  room=next;
  $('count').textContent=room.members.length;
  $('room-label').textContent='Комната · '+session.room.slice(0,6);
  if(changed) {
    destroyStreamPlayer();
    version=nextVersion;
    streamCatalog=null;
    currentStream=null;
    qualityPreference='auto';
    playAttempt=null;
    sourceFailed=false;
    sourceLoading=!!version;
    isScrubbing=false;
    watchPositions.clear();
    movie.pause();
    movie.removeAttribute('src');
    movie.load();
    $('screen').classList.toggle('has-video',!!version);
    $('empty').hidden=!!version;
    showQualities(null);
    if(version) {
      $('movie-name').textContent=room.video.name;
      $('movie-detail').textContent=fileSize(room.video.size);
      const expected=version;
      loadCatalog().catch(()=>{}).finally(()=>{
        if(version===expected&&!currentStream)useQuality('auto',true);
      });
    }
  }
  updateHostRole(previousHost);
  syncPlayback(newPlayback);
  renderPeople();
  renderCallLayout();
  renderMessages();
  access();
  renderHostSelector();
  updateTime();
  updateBufferDisplay();
  scheduleWatch();
  const ids=new Set(room.members.map(member=>member.id));
  for(const [key,peer]of peers)if(!ids.has(key)){peer.pc.close();peers.delete(key);watchPositions.delete(key);const tile=screenCards.get(key);if(tile){screenCards.delete(key);removeTile(tile);}}
  for(const member of room.members)if(member.id!==session.id&&!peers.has(member.id))makePeer(member.id);
}
function setParticipantsOpen(open) {
  participantsOpen=!!open;
  const available=!callView&&fullscreen();
  const visible=available&&participantsOpen;
  $('participants-drawer').hidden=!visible;
  $('participants-toggle').hidden=!available;
  $('participants-toggle').setAttribute('aria-expanded',String(visible));
  $('participants-toggle-label').textContent=participantsOpen?'↓ Скрыть участников':'↑ Участники';
  $('player').classList.toggle('participants-open',visible);
  if(typeof showFullscreenControls==='function')showFullscreenControls();
}
function refreshParticipantDrawer() {
  const target=$(callView?'call-tiles':fullscreen()?'participants-tiles':'sidebar-tiles');
  if($('people').parentElement!==target)target.append($('people'));
  $('participants-count').textContent=room?.members.length||0;
  $('participants-toggle').disabled=!session;
  setParticipantsOpen(participantsOpen);
}
function closeScreenFullscreen() {
  const tile=expandedScreen;
  if(!tile)return;
  if(tile.classList.contains('screen-fullscreen-fallback')) {
    tile.classList.remove('screen-fullscreen-fallback');
    const parent=screenReturn?.parent?.isConnected?screenReturn.parent:$('people');
    const next=screenReturn?.next;
    parent.insertBefore(tile,next?.parentElement===parent?next:null);
  }
  if(document.fullscreenElement===tile)document.exitFullscreen().catch(()=>{});
  tile.querySelector('.screen-expand')?.setAttribute('aria-label','Развернуть демонстрацию на весь экран');
  expandedScreen=null;screenReturn=null;
}
async function openScreenFullscreen(tile) {
  if(expandedScreen===tile){closeScreenFullscreen();return;}
  closeScreenFullscreen();expandedScreen=tile;
  try {await tile.requestFullscreen();}
  catch {
    if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});
    if(expandedScreen!==tile||!tile.isConnected)return;
    screenReturn={parent:tile.parentElement,next:tile.nextSibling};
    document.body.append(tile);tile.classList.add('screen-fullscreen-fallback');
  }
  tile.querySelector('.screen-expand')?.setAttribute('aria-label','Свернуть демонстрацию');
}
function renderCallLayout() {
  refreshParticipantDrawer();
  refreshCameraWindow();
  const tiles=$('people');
  tiles.classList.toggle('is-focused',callView&&!!focusedTile);
  const self=cards.get(session?.id);
  const select=$('call-focus');
  const entries=[...cards.values(),...screenCards.values()];
  select.replaceChildren(new Option('Все участники',''));
  select.append(...entries.map((tile,index)=>new Option(tile.dataset.focusLabel,String(index))));
  select.value=focusedTile?String(entries.indexOf(focusedTile)):'';
  for(const tile of entries) {
    tile.classList.toggle('is-main',callView&&tile===focusedTile);
    tile.classList.toggle('is-preview',callView&&!!focusedTile&&tile!==focusedTile&&tile===self);
    tile.querySelector('.focus-tile')?.setAttribute('aria-pressed',String(callView&&tile===focusedTile));
  }
}
function setCallView(on) {
  callView=on;
  $('cinema').hidden=on;
  $('call-stage').hidden=!on;
  $('movie-mode').setAttribute('aria-pressed',String(!on));
  $('call-mode').setAttribute('aria-pressed',String(on));
  renderCallLayout();
}
function addFocusButton(tile,label) {
  const button=document.createElement('button');
  tile.dataset.focusLabel=label;
  button.type='button';
  button.className='focus-tile';
  button.setAttribute('aria-label',label);
  button.setAttribute('aria-pressed','false');
  button.onclick=()=>{
    focusedTile=callView&&focusedTile===tile?null:tile;
    setCallView(true);
  };
  tile.append(button);
}
function removeTile(tile) {
  if(expandedScreen===tile)closeScreenFullscreen();
  if(focusedTile===tile)focusedTile=null;
  tile.remove();
  renderCallLayout();
}
function attachScreen(id,stream) {
  const track=stream?.getVideoTracks().find(item=>item.readyState==='live'&&!item.muted);
  let tile=screenCards.get(id);
  if(!track) {
    if(tile){screenCards.delete(id);removeTile(tile);}
    return;
  }
  if(!tile) {
    tile=document.createElement('div');
    tile.className='person screen-tile';
    const name=room?.members.find(member=>member.id===id)?.name||'Участник';
    const video=document.createElement('video'),label=document.createElement('span');
    video.autoplay=true;video.playsInline=true;video.muted=true;
    label.className='screen-name';label.textContent='Экран · '+name;
    tile.append(video,label);
    addFocusButton(tile,'Показать экран участника '+name);
    const expand=document.createElement('button');expand.type='button';expand.className='screen-expand';expand.textContent='⛶';expand.setAttribute('aria-label','Развернуть демонстрацию на весь экран');
    expand.onclick=event=>{event.stopPropagation();openScreenFullscreen(tile);};
    const collapse=document.createElement('button');collapse.type='button';collapse.className='screen-collapse button';collapse.textContent='Свернуть ⛶';collapse.onclick=()=>closeScreenFullscreen();
    tile.append(expand,collapse);video.ondblclick=()=>openScreenFullscreen(tile);

    screenCards.set(id,tile);
    $('people').append(tile);
  }
  const video=tile.querySelector('video');
  if(video.dataset.tracks!==track.id) {
    video.dataset.tracks=track.id;
    video.srcObject=new MediaStream([track]);
    video.play().catch(()=>{});
  }
  if(id!==session?.id)bindCallAudio(tile,stream);
  renderCallLayout();
}
function bindCallAudio(tile,stream) {
  let audio=tile.querySelector('audio');
  if(!audio){audio=document.createElement('audio');audio.autoplay=true;tile.append(audio);}
  audio.muted=callMuted;
  const tracks=stream.getAudioTracks().filter(track=>track.readyState==='live');
  const key=tracks.map(track=>track.id).join(',');
  if(audio.dataset.tracks!==key) {
    audio.dataset.tracks=key;
    audio.srcObject=new MediaStream(tracks);
  }
  if(tracks.length&&!callMuted)audio.play().catch(()=>{$('enable-audio').hidden=false;});
}
function setCallMuted(muted) {
  callMuted=muted;
  $('mute-call').setAttribute('aria-pressed',String(muted));
  $('mute-call').textContent=muted?'Вернуть звук звонка':'Заглушить звонок';
  for(const audio of $('people').querySelectorAll('audio')) {
    audio.muted=muted;
    if(!muted&&audio.srcObject?.getAudioTracks().length)audio.play().catch(()=>$('enable-audio').hidden=false);
  }
  if(muted)$('enable-audio').hidden=true;
}
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
  if(id!==session.id)bindCallAudio(card,stream);
  refreshCameraWindow();
}
function refreshCameraWindow() {
  const button=$('camera-window');
  const supported=!!window.documentPictureInPicture;
  const open=!!cameraWindow&&!cameraWindow.closed;
  button.hidden=!supported;
  button.disabled=!session||cameraWindowOpening||!supported;
  button.setAttribute('aria-pressed',String(open));
  button.textContent=open?'Закрыть окно камер':'Камеры поверх окон';
  button.title=supported?'Окно можно двигать и менять в размере. Правый клик закрывает его.':'Для окна с несколькими камерами нужен браузер с Document Picture-in-Picture, например Chrome.';
  if(!open||!cameraWindowGrid)return;
  const visible=new Set();
  for(const [id,card] of cards) {
    const source=card.querySelector('video');
    const track=source.srcObject?.getVideoTracks().find(track=>track.readyState==='live'&&track.enabled&&!track.muted);
    if(source.hidden||!track)continue;
    visible.add(id);
    let tile=cameraWindowCards.get(id);
    if(!tile) {
      tile=cameraWindow.document.createElement('div');
      tile.className='camera-window-tile';
      const video=cameraWindow.document.createElement('video');
      video.autoplay=true;video.playsInline=true;video.muted=true;
      const label=cameraWindow.document.createElement('span');
      tile.append(video,label);
      cameraWindowGrid.append(tile);
      cameraWindowCards.set(id,tile);
    }
    const video=tile.querySelector('video');
    tile.querySelector('span').textContent=card.querySelector('.person-name').textContent;
    if(video.dataset.track!==track.id) {
      video.dataset.track=track.id;
      video.srcObject=new MediaStream([track]);
      video.play().catch(()=>{});
    }
  }
  for(const [id,tile] of cameraWindowCards)if(!visible.has(id)) {
    tile.querySelector('video').srcObject=null;
    tile.remove();
    cameraWindowCards.delete(id);
  }
  cameraWindow.document.getElementById('camera-window-empty').hidden=visible.size>0;
}
function closeCameraWindow() {
  const popup=cameraWindow;
  cameraWindow=null;cameraWindowGrid=null;
  for(const tile of cameraWindowCards.values())tile.querySelector('video').srcObject=null;
  cameraWindowCards.clear();
  popup?.close();
  refreshCameraWindow();
}
async function toggleCameraWindow() {
  if(cameraWindow&&!cameraWindow.closed){closeCameraWindow();return;}
  if(!session||cameraWindowOpening)return;
  if(!window.documentPictureInPicture){toast('Открой Together в Chrome, чтобы вынести камеры поверх других окон.');return;}
  const current=session;
  cameraWindowOpening=true;
  refreshCameraWindow();
  try {
    const popup=await window.documentPictureInPicture.requestWindow({width:360,height:240});
    if(session!==current){popup.close();return;}
    cameraWindow=popup;
    popup.addEventListener('pagehide',()=>{if(cameraWindow===popup)closeCameraWindow();},{once:true});
    const doc=popup.document;
    doc.title='Together — камеры';
    const style=doc.createElement('link');
    style.rel='stylesheet';style.href=new URL('/style.css',location.href).href;
    doc.head.append(style);
    doc.body.className='camera-window-view';
    cameraWindowGrid=doc.createElement('div');
    cameraWindowGrid.className='camera-window-grid';
    const empty=doc.createElement('p');
    empty.id='camera-window-empty';empty.textContent='Камеры выключены';
    doc.body.append(cameraWindowGrid,empty);
    doc.addEventListener('contextmenu',event=>{event.preventDefault();closeCameraWindow();});
  }catch {
    closeCameraWindow();
    toast('Не удалось открыть окно камер. Разреши Picture-in-Picture в настройках браузера.');
  }finally {
    cameraWindowOpening=false;
    refreshCameraWindow();
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
    callMuted,
    screenCapture:displayCapture?{surface:displayCapture.getVideoTracks()[0]?.getSettings().displaySurface||null,
      audio:displayCapture.getAudioTracks().length>0}:null,
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
        if (item.type === 'inbound-rtp' || item.type === 'outbound-rtp') entry.media.push({direction:item.type,kind:item.kind || item.mediaType,bytesReceived:item.bytesReceived,bytesSent:item.bytesSent,packetsReceived:item.packetsReceived,packetsSent:item.packetsSent,packetsLost:item.packetsLost,jitter:item.jitter,concealedSamples:item.concealedSamples,totalSamplesReceived:item.totalSamplesReceived,audioLevel:item.audioLevel,framesDecoded:item.framesDecoded,framesEncoded:item.framesEncoded});
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

function renderPeople(){const ids=new Set(room.members.map(m=>m.id));for(const [id,card]of cards)if(!ids.has(id)){cards.delete(id);removeTile(card);}if(!cards.size)$('people').replaceChildren();for(const member of room.members){let card=cards.get(member.id);if(!card){card=document.createElement('div');card.className='person';const avatar=document.createElement('span');avatar.className='avatar';const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.hidden=true;video.muted=member.id===session.id;if(video.muted)video.className='self';const name=document.createElement('span');name.className='person-name';const badge=document.createElement('span');badge.className='host-badge';badge.textContent='ВЕДУЩИЙ';const give=document.createElement('button');give.className='give-host';give.textContent='♔';give.title='Передать управление';give.onclick=()=>transferHost(member.id);const timestamp=document.createElement('span');timestamp.className='person-time';timestamp.setAttribute('aria-label','Позиция просмотра');card.append(avatar,video,name,badge,give,timestamp);addFocusButton(card,'Показать камеру участника '+member.name);cards.set(member.id,card);$('people').append(card);}card.querySelector('.avatar').textContent=member.name.slice(0,2).toUpperCase();card.querySelector('.person-name').textContent=member.name+(member.id===session.id?' · ты':'');card.querySelector('.host-badge').hidden=room.host!==member.id;card.querySelector('.give-host').hidden=!host()||member.id===session.id;attach(member.id,member.id===session.id?media:peers.get(member.id)?.stream);updateParticipantTime(member.id);}}
function updateParticipantTime(id) {
  const label=cards.get(id)?.querySelector('.person-time');
  if(!label)return;
  if(!version){label.textContent='Видео не выбрано';return;}
  const value=id===session?.id?{version,position:movie.currentTime||0,paused:movie.paused,waiting:movie.readyState<3,receivedAt:Date.now()}:watchPositions.get(id);
  if(!value || Date.now()-value.receivedAt>10000){label.textContent='— · нет данных';return;}
  if(value.version!==version){label.textContent='Ждёт видео';return;}
  label.textContent=time(value.position)+' · '+(value.waiting?'загрузка':value.paused?'пауза':'смотрит');
}
function scheduleWatch() {
  if(!session||!version||!connected)return;
  if(watchBusy){watchAgain=true;return;}
  if(!watchTimer)watchTimer=setTimeout(shareWatchPosition,100);
}
async function shareWatchPosition() {
  watchTimer=null;
  if(!session||!version||!connected)return;
  watchBusy=true;
  const duration=Number.isFinite(movie.duration)?movie.duration:streamCatalog?.duration||0;
  const watch={
    version,sequence:room.playback.sequence,position:movie.currentTime||0,duration,
    paused:movie.paused,waiting:!!(room.video.growing&&movie.ended)||!duration||sourceLoading||sourceFailed||unlocking||movie.seeking||(!movie.ended&&(mediaWaiting||movie.readyState<3)),
    blocked:autoplayBlocked,bufferAhead:bufferedAhead(movie)
  };
  const current=session;
  try{
    const result=await command('watch',watch);
    if(current===session&&result.playback)receivePlayback(result.playback);
  }
  catch(error){if(current===session&&error.status!==401&&connected)reconnect('watch_'+(error.status||'network'));}
  finally {
    watchBusy=false;
    if(watchAgain){watchAgain=false;scheduleWatch();}
  }
}
async function leaveRoom() {
  if(!session)return;
  closeCameraWindow();
  isScrubbing=false;const old=session;forgetSession(old.room);
  micTestTrack?.stop();
  micTestTrack=null;
  $('mic-test').textContent='Записать тест микрофона';
  const micSample=$('mic-test-audio');
  micSample.removeAttribute('src');micSample.load();micSample.hidden=true;
  if(micTestUrl)URL.revokeObjectURL(micTestUrl);
  micTestUrl=null;
  if($('library').open)$('library').close();
  const leaveUrl=endpoint('leave');
  upload?.abort();
  clearTimeout(reconnectTimer);reconnectTimer=null;reconnectReason=null;clearTimeout(mediaRetry);mediaRetry=null;
  events?.close();events=null;
  connected=false;session=null;room=null;version=null;autoplayBlocked=false;playAttempt=null;
  clearTimeout(startTimer);clearTimeout(watchTimer);watchTimer=null;watchAgain=false;
  for(const peer of peers.values())peer.pc.close();peers.clear();
  if(displayCapture){for(const track of displayCapture.getTracks())track.stop();displayCapture=null;}
  closeScreenFullscreen();
  for(const tile of screenCards.values())tile.remove();screenCards.clear();focusedTile=null;participantsOpen=false;
  setCallView(false);setCallMuted(false);updateScreenButton();
  for(const track of media.getTracks()){track.stop();media.removeTrack(track);}
  destroyStreamPlayer();streamCatalog=null;currentStream=null;sourceLoading=false;sourceFailed=false;movie.pause();movie.removeAttribute('src');movie.load();
  for(const card of cards.values()){for(const element of card.querySelectorAll('video,audio'))element.srcObject=null;card.remove();}
  cards.clear();watchPositions.clear();
  $('screen').classList.remove('has-video');$('empty').hidden=false;$('enable-play').hidden=true;
  $('count').textContent='0';$('connection').textContent='НЕ В СЕТИ';$('room-label').textContent='Личная комната';
  $('movie-name').textContent='Твой следующий любимый фильм';$('movie-detail').textContent='Добавь видео, а мы позаботимся о синхронизации';
  $('people').replaceChildren();$('messages').replaceChildren();$('chat-input').value='';
  $('invite').disabled=true;$('leave-room').hidden=true;$('enable-audio').hidden=true;
  for(const key of ['mic','camera','camera-window','call-mode','share-screen','share-audio','mute-call','mic-processing','mic-test','chat-input','send'])$(key).disabled=true;
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
setInterval(scheduleWatch,1500);
movie.addEventListener('timeupdate',()=>{if(session)updateParticipantTime(session.id);});

function addMessage(message){$('messages').querySelector('.chat-welcome')?.remove();const item=document.createElement('div');item.className='message'+(message.from===session.id?' own':'');const author=document.createElement('div');author.className='message-author';author.textContent=message.name;const timestamp=document.createElement('time');timestamp.textContent=new Date(message.at).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});author.append(timestamp);const text=document.createElement('div');text.className='message-text';text.textContent=message.text;item.append(author,text);$('messages').append(item);$('messages').scrollTop=$('messages').scrollHeight;}
function renderMessages(){$('messages').replaceChildren();if(!room.messages.length){const intro=document.createElement('div');intro.className='chat-welcome';intro.textContent='✳ Здесь можно обсуждать всё. Но лучше без спойлеров.';$('messages').append(intro);}for(const message of room.messages)addMessage(message);}
function reconnect(reason) {
  if(!session||reconnectTimer)return;
  if(reason)reconnectReason=reason;
  const current=session;
  events?.close();
  events=null;
  connected=false;
  clearTimeout(startTimer);
  movie.pause();
  $('connection').textContent='ПЕРЕПОДКЛЮЧЕНИЕ';
  access();
  renderHostSelector();
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    if(session!==current)return;
    try {
      const response=await fetch(mediaUrl('session'),{method:'HEAD',signal:AbortSignal.timeout(5000)});
      if(session!==current)return;
      if(response.status===401||response.status===404){location.reload();return;}
      if(!response.ok){reconnect();return;}
      connect();
    }catch{if(session===current)reconnect();}
  },1800);
}
function connect() {
  events?.close();
  const source=new EventSource(mediaUrl('events'));
  events=source;
  lastRoomEvent=Date.now();
  source.onerror=()=>{if(events===source)reconnect('events_closed');};
  source.addEventListener('heartbeat',()=>{if(events===source)lastRoomEvent=Date.now();});
  source.addEventListener('state',event=>{
    if(events!==source)return;
    lastRoomEvent=Date.now();
    const reconnected=!connected;
    connected=true;
    $('connection').textContent='В СЕТИ';
    state(JSON.parse(event.data));
    if(reconnected) {
      syncClock().then(()=>syncPlayback());
      if(reconnectReason){command('clientevent',{reason:reconnectReason}).catch(()=>{});reconnectReason=null;}
    }
  });
  source.addEventListener('playback',event=>receivePlayback(JSON.parse(event.data)));
  source.addEventListener('media',event=>applyCatalog(JSON.parse(event.data)));
  source.addEventListener('watch',event=>{
    const report=JSON.parse(event.data);
    if(report.version!==version)return;
    watchPositions.set(report.id,{...report,receivedAt:Date.now()});
    updateParticipantTime(report.id);
    if(room?.playback.phase==='buffering')updateBufferDisplay();
  });
  source.addEventListener('chat',event=>{
    const message=JSON.parse(event.data);
    room.messages.push(message);
    room.messages=room.messages.slice(-80);
    addMessage(message);
  });
  source.addEventListener('signal',async event=>{
    const data=JSON.parse(event.data);
    try{await signal(data.from,data.signal);}
    catch(error){console.warn('WebRTC',error);$('call-note').textContent='Связь не установилась. Для некоторых сетей нужен TURN-сервер.';}
  });
}
function savedSession(roomId) {try{return JSON.parse(sessionStorage.getItem('together-session:'+roomId)||'null');}catch{return null;}}
function rememberSession(value,name){try{sessionStorage.setItem('together-session:'+value.room,JSON.stringify({...value,name}));}catch{}}
function forgetSession(roomId){try{sessionStorage.removeItem('together-session:'+roomId);}catch{}}
async function enter(e){
  e.preventDefault();if(joining)return;joining=true;$('join-button').disabled=true;
  try {
    const old=requestedRoom?savedSession(requestedRoom):null;
    const name=($('name').value||old?.name||'').trim();if(!name)throw new Error('Введи своё имя');
    try{localStorage.setItem('together-name',name);}catch{}
    config=await fetch('/api/config').then(r=>r.json());
    if(requestedRoom){
      const joinUrl='/api/rooms/'+encodeURIComponent(requestedRoom)+'/join';
      try{session=await api(joinUrl,{name,...(old?.token?{token:old.token}:{})},false);}
      catch(error){if(error.status!==401||!old)throw error;forgetSession(requestedRoom);session=await api(joinUrl,{name},false);}
    }else session=await api('/api/rooms',{name},false);
    rememberSession(session,name);requestedRoom=session.room;history.replaceState(null,'','?room='+session.room);
    $('new-room').hidden=true;$('welcome').close();$('invite').disabled=false;$('leave-room').hidden=false;
    for(const key of ['mic','camera','call-mode','share-screen','share-audio','mute-call','mic-processing','mic-test','chat-input','send'])$(key).disabled=false;
    updateScreenButton();
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
  const peer = {pc,stream,screen:new MediaStream(),initiator,makingOffer:false,ignoreOffer:false,settingAnswer:false,polite:!initiator,candidates:[],signalQueue:Promise.resolve(),restarted:false,ready:false,helloAnswered:false,localCandidates:[],remoteCandidates:[],iceErrors:[],signalErrors:[]};
  peers.set(id, peer);
  // Only the caller creates transceivers. The answerer reuses those from the offer.
  if(initiator)for(const slot of ['audio','video','screen','screenAudio']) {
    const source=streamForSlot(slot),kind=kindForSlot(slot);
    const track=source?.getTracks().find(item=>item.kind===kind&&item.readyState==='live');
    pc.addTransceiver(track||kind,{direction:'sendrecv',streams:source?[source]:[]});
  }
  pc.onicecandidate = event => {
    if (event.candidate) {peer.localCandidates.push(summarizeCandidate(event.candidate));command('signal',{to:id,signal:{candidate:event.candidate}}).catch(error => peer.signalErrors.push(error.message));}
  };
  pc.onicecandidateerror = event => {peer.iceErrors.push({code:event.errorCode,message:event.errorText,url:event.url});};
  pc.ontrack = event => {
    const slot=slotForTransceiver(pc,event.transceiver);
    const sharing=slot==='screen'||slot==='screenAudio';
    const incoming=sharing?peer.screen:stream;
    const refresh=()=>sharing?attachScreen(id,peer.screenActive?incoming:null):attach(id,incoming);
    incoming.addTrack(event.track);
    event.track.onunmute=refresh;
    event.track.onmute=refresh;
    event.track.onended=()=>{incoming.removeTrack(event.track);refresh();};
    refresh();
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
  command('signal',{to:id,signal:{hello:true,screenActive:!!displayCapture}}).catch(() => {});
  return peer;
}
function signal(from, input) {
  const peer = peers.get(from) || makePeer(from);
  // Description changes and ICE candidates must be applied in arrival order.
  const operation = peer.signalQueue.then(() => applySignal(from,peer,input));
  peer.signalQueue = operation.catch(error => {peer.signalErrors.push(error.message);});
  return operation;
}
async function applySignal(from, peer, input) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  if(typeof input.screenActive==='boolean') {
    peer.screenActive=input.screenActive;
    if(peer.screen.getTracks().length)attachScreen(from,peer.screenActive?peer.screen:null);
  }
  if (input.hello) {
    peer.ready = true;
    if (!peer.helloAnswered) {peer.helloAnswered = true;await command('signal',{to:from,signal:{hello:true,screenActive:!!displayCapture}});}
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
        const source=streamForSlot(slotForTransceiver(pc,transceiver));
        const track=source?.getTracks().find(t=>t.kind===transceiver.receiver.track.kind&&t.readyState==='live');
        transceiver.sender.setStreams?.(...(source?[source]:[]));
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

function kindForSlot(slot) {
  if(slot==='screen')return 'video';
  if(slot==='screenAudio')return 'audio';
  return slot;
}
function slotForTransceiver(pc,transceiver) {
  const kind=transceiver.receiver.track.kind;
  const tracks=pc.getTransceivers().filter(item=>item.receiver.track.kind===kind);
  if(tracks.indexOf(transceiver)>0)return kind==='video'?'screen':'screenAudio';
  return kind;
}
function streamForSlot(slot) {
  return slot==='screen'||slot==='screenAudio'?displayCapture:media;
}
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
    const display=kind==='screen'||kind==='screenAudio';
    const type=kind==='screen'?'video':kind==='screenAudio'?'audio':kind;
    const transceiver=peer.pc.getTransceivers().filter(t=>t.receiver.track.kind===type)[display?1:0];
    if(transceiver&&!transceiver.stopped)await transceiver.sender.replaceTrack(track);
    else if(!display&&track&&peer.pc.remoteDescription)peer.pc.addTrack(track,media);
  }));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    console.warn('Отправка медиадорожки:', failed.map(result => result.reason));
    $('call-note').textContent = 'Устройство включено, но передать его одному из участников не удалось. Попробуйте перезайти в комнату.';
  }
}
function microphoneConstraints() {
  const processing=$('mic-processing').checked!==false;
  return {echoCancellation:processing,noiseSuppression:processing,autoGainControl:false};
}
async function recordMicTest() {
  const current=session,button=$('mic-test'),sample=$('mic-test-audio');
  if(!current)return;
  if(typeof MediaRecorder==='undefined'||!navigator.mediaDevices?.getUserMedia) {
    toast('Этот браузер не поддерживает тест микрофона.');
    return;
  }
  button.disabled=true;
  let track;
  try {
    sample.pause();
    track=media.getAudioTracks().find(item=>item.readyState==='live'&&item.enabled)?.clone();
    if(!track) {
      const source=await navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(),video:false});
      track=source.getAudioTracks()[0];
    }
    if(session!==current)return;
    micTestTrack=track;
    const recorder=new MediaRecorder(new MediaStream([track]));
    const chunks=[];
    const recording=new Promise((resolve,reject)=>{
      recorder.ondataavailable=event=>chunks.push(event.data);
      recorder.onerror=()=>reject(new Error('Ошибка записи'));
      recorder.onstop=()=>resolve(new Blob(chunks,{type:recorder.mimeType}));
    });
    recorder.start();
    button.textContent='Запись 4 секунды…';
    const timer=setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},4000);
    let audio;
    try{audio=await recording;}finally{clearTimeout(timer);}
    if(session!==current)return;
    if(micTestUrl)URL.revokeObjectURL(micTestUrl);
    micTestUrl=URL.createObjectURL(audio);
    sample.src=micTestUrl;
    sample.hidden=false;
  } catch {
    if(session===current)toast('Не удалось записать тест микрофона.');
  } finally {
    track?.stop();
    if(micTestTrack===track)micTestTrack=null;
    if(session===current) {
      button.textContent='Записать тест микрофона';
      button.disabled=false;
    }
  }
}
async function changeMicrophoneProcessing() {
  const input=$('mic-processing');
  const track=media.getAudioTracks().find(item=>item.readyState==='live');
  if(!track)return;
  const wasOn=track.enabled;
  media.removeTrack(track);
  track.stop();
  updateDevices();
  if(!wasOn)return;
  input.disabled=true;
  try {
    await toggle('audio');
  } finally {
    input.disabled=!session;
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
          ? {audio:microphoneConstraints(),video:false}
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
function updateScreenButton() {
  const button=$('share-screen');
  const supported=!!navigator.mediaDevices?.getDisplayMedia;
  button.hidden=!supported;
  button.classList.toggle('on',!!displayCapture);
  button.setAttribute('aria-pressed',String(!!displayCapture));
  button.lastElementChild.textContent=displayCapture?'Остановить показ':'Показать экран';
  $('share-audio').disabled=!session||!!displayCapture||!supported;
  $('share-audio').closest('label').hidden=!supported;
}
async function stopScreenShare() {
  if(!displayCapture)return;
  const capture=displayCapture;
  displayCapture=null;
  for(const track of capture.getTracks())track.stop();
  updateScreenButton();
  if(session)attachScreen(session.id,null);
  await Promise.all([announceScreen(false),sendTrack('screen',null),sendTrack('screenAudio',null)]);
}
function announceScreen(screenActive) {
  return Promise.allSettled([...peers.keys()].map(to=>command('signal',{to,signal:{screenActive}})));
}
async function toggleScreenShare() {
  if(displayCapture){await stopScreenShare();return;}
  const current=session,button=$('share-screen');
  if(!current||!navigator.mediaDevices?.getDisplayMedia){
    toast('Демонстрация экрана доступна в поддерживаемом браузере по HTTPS.');
    return;
  }
  button.disabled=true;
  $('share-audio').disabled=true;
  const withAudio=$('share-audio').checked;
  const canExcludeOwnAudio=navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio===true;
  try {
    const capture=await navigator.mediaDevices.getDisplayMedia({
      video:{width:{ideal:1280},frameRate:{ideal:20,max:30}},
      audio:withAudio?{restrictOwnAudio:true,suppressLocalAudioPlayback:false}:false,
      selfBrowserSurface:'exclude',
      surfaceSwitching:'exclude',
      systemAudio:withAudio&&canExcludeOwnAudio?'include':'exclude',
      windowAudio:withAudio&&canExcludeOwnAudio?'window':'exclude'
    });
    const video=capture.getVideoTracks()[0];
    if(session!==current||!video){for(const track of capture.getTracks())track.stop();return;}
    const surface=video.getSettings().displaySurface;
    let excludedUnsafeAudio=false;
    for(const track of capture.getAudioTracks()) {
      if(!withAudio||surface!=='browser'&&track.getSettings().restrictOwnAudio!==true) {
        excludedUnsafeAudio=withAudio;
        capture.removeTrack(track);track.stop();
      }
    }
    if('contentHint' in video)video.contentHint='detail';
    displayCapture=capture;
    video.addEventListener('ended',()=>{if(displayCapture===capture)stopScreenShare();},{once:true});
    updateScreenButton();
    attachScreen(current.id,capture);
    focusedTile=screenCards.get(current.id)||null;
    setCallView(true);
    await Promise.all([announceScreen(true),sendTrack('screen',video),sendTrack('screenAudio',capture.getAudioTracks()[0]||null)]);
    if(excludedUnsafeAudio) {
      $('call-note').textContent='Показ идёт без звука: браузер не смог исключить звук Together. Для передачи звука выбери отдельную вкладку или обнови Chrome.';
    } else if(!withAudio) {
      $('call-note').textContent='Демонстрация без звука.';
    } else if(capture.getAudioTracks().length) {
      $('call-note').textContent='Демонстрация со звуком. Звук Together исключён.';
    } else {
      $('call-note').textContent='Браузер передал только видео. Для звука включи его передачу в окне выбора экрана или выбери вкладку браузера.';
    }
  } catch(error) {
    if(error.name!=='NotAllowedError')toast('Не удалось запустить демонстрацию экрана.');
  } finally {button.disabled=!session;$('share-audio').disabled=!session||!!displayCapture;}
}
function getLibraryKey() {
  const generated=[...crypto.getRandomValues(new Uint8Array(24))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  try {
    const saved=localStorage.getItem('together-library');
    if(/^[a-f0-9]{48}$/.test(saved||''))return saved;
    localStorage.setItem('together-library',generated);
  }catch{}
  return generated;
}
function fileSize(bytes) {
  return bytes>=1024**3?(bytes/1024**3).toFixed(1)+' ГБ':Math.max(1,Math.round(bytes/1024**2))+' МБ';
}
async function openLibrary() {
  $('local-source-help').hidden=!config?.localSourceOwner;
  if(!host()||!connected||upload||libraryBusy)return;
  const current=session,list=$('library-list'),dialog=$('library');
  list.replaceChildren();
  $('library-status').textContent='Открываю библиотеку…';
  dialog.showModal();
  try {
    const response=await fetch(endpoint('library'),{headers:{Authorization:'Bearer '+session.token,'X-Library-Key':libraryKey},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error();
    const {videos}=await response.json();
    if(session!==current||!dialog.open)return;
    $('library-status').textContent=videos.length?'':'Здесь появятся файлы после первой загрузки.';
    for(const video of videos) {
      const button=document.createElement('button'),name=document.createElement('span'),size=document.createElement('small');
      button.type='button';
      button.className='library-video';
      name.textContent=video.name;
      size.textContent=fileSize(video.size);
      button.append(name,size);
      button.onclick=async()=>{
        if(libraryBusy||session!==current||!host())return;
        libraryBusy=true;
        button.disabled=true;
        $('library-upload').disabled=true;
        try {
          await command('select',{id:video.id});
          if(dialog.open)dialog.close();
        }catch(error){toast(error.message);}
        finally{libraryBusy=false;button.disabled=false;$('library-upload').disabled=false;}
      };
      list.append(button);
    }
  } catch {
    if(session===current)$('library-status').textContent='Не удалось открыть список сохранённых файлов.';
  }
}
function uploadFile(file) {
  if(!host()||!connected||upload||libraryBusy||!file)return;
  if(file.size>config.maxBytes){toast(`Максимальный размер — ${Math.round(config.maxBytes/1024**3)} ГБ`);return;}
  if(!file.size){toast('Файл пустой');return;}
  const xhr=new XMLHttpRequest();
  upload=xhr;
  access();
  $('upload-panel').hidden=false;
  $('upload-name').textContent=file.name;
  $('upload-progress').style.width='0%';
  $('upload-status').textContent='Сохраняю видео…';
  xhr.open('POST',endpoint('upload'));
  xhr.setRequestHeader('Authorization','Bearer '+session.token);
  xhr.setRequestHeader('X-Library-Key',libraryKey);
  xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
  xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.upload.onprogress=event=>{
    if(!event.lengthComputable)return;
    const percent=Math.round(event.loaded/event.total*100);
    $('upload-progress').style.width=percent+'%';
    $('upload-status').textContent=percent===100?'Сохраняю видео…':`Загрузка · ${percent}%`;
  };
  xhr.onload=()=>{
    if(xhr.status>=200&&xhr.status<300){toast('Видео добавлено в библиотеку');return;}
    let message='Не удалось загрузить видео';
    try{message=JSON.parse(xhr.responseText).error||message;}catch{}
    toast(message);
  };
  xhr.onerror=()=>toast('Соединение прервалось. Попробуй загрузить файл заново.');
  xhr.onabort=()=>toast('Загрузка отменена');
  xhr.onloadend=()=>{upload=null;$('upload-panel').hidden=true;$('file').value='';access();};
  xhr.send(file);
}
$('diagnostics').ontoggle=async()=>{if($('diagnostics').open)$('diagnostics-output').value=await connectionReport();};
$('copy-diagnostics').onclick=async()=>{const report=await connectionReport();$('diagnostics-output').value=report;try{await navigator.clipboard.writeText(report);toast('Диагностика скопирована. Отправь её в чат.');}catch{$('diagnostics-output').select();toast('Нажми Ctrl+C, чтобы скопировать отчёт');}};
$('new-room').onclick=()=>{if(requestedRoom)forgetSession(requestedRoom);requestedRoom=null;history.replaceState(null,'','/');$('welcome-title').textContent='Твой вечер начинается здесь.';$('welcome-copy').textContent='Создай комнату и отправь друзьям новую ссылку.';$('join-button').textContent='Создать комнату ↗';$('new-room').hidden=true;};
$('host-selector').onchange=()=>transferHost($('host-selector').value);
$('leave-room').onclick=leaveRoom;
$('join-form').onsubmit=enter;try{$('name').value=localStorage.getItem('together-name')||'';}catch{}
if(requestedRoom){$('welcome-title').textContent='Тебя уже ждут.';$('welcome-copy').textContent='Зайди в комнату и устройтесь поудобнее. Фильм лучше смотреть вместе.';$('join-button').textContent='Присоединиться ↗';}$('welcome').addEventListener('cancel',e=>e.preventDefault());$('welcome').showModal();if(requestedRoom&&savedSession(requestedRoom))enter({preventDefault(){}});
$('invite').onclick=async()=>{
  const roomId=session?.room;
  if(!roomId)return;
  let address;
  try{address=await fetch('/api/address',{signal:AbortSignal.timeout(5000)}).then(response=>response.json());}
  catch{toast('Не удалось получить ссылку');return;}
  if(session?.room!==roomId)return;
  if(!address.url&&address.sharing){toast('Публичная ссылка пока недоступна. Проверь окно запуска.');return;}
  const link=new URL('/',address.url||location.origin);
  link.searchParams.set('room',roomId);
  try {
    await navigator.clipboard.writeText(link.href);
    toast(!address.url&&['localhost','127.0.0.1'].includes(location.hostname)?
      'Скопирована локальная ссылка. Для друзей через интернет запусти npm run share.':'Ссылка скопирована');
  }catch{prompt('Скопируй ссылку на комнату',link.href);}
};
$('pick').onclick=$('replace').onclick=openLibrary;
$('library-close').onclick=()=>$('library').close();
$('library-upload').onclick=()=>{$('library').close();$('file').click();};
$('file').onchange=()=>uploadFile($('file').files[0]);
$('cancel-upload').onclick=()=>upload?.abort();
$('screen').ondragover=event=>event.preventDefault();
$('screen').ondrop=event=>{event.preventDefault();uploadFile(event.dataTransfer.files[0]);};

$('play').onclick=requestPlayPause;
$('back').onclick=()=>seekBy(-10);
$('seek').onpointerdown=()=>{isScrubbing=host();};
$('seek').oninput=()=>{isScrubbing=true;updateTime();};
$('seek').onchange=()=>{
  const position=Number($('seek').value);
  isScrubbing=false;
  seekTo(position);
};
function stopScrubbing(){if(isScrubbing){isScrubbing=false;updateTime();}}
$('seek').onblur=stopScrubbing;
$('seek').onpointercancel=stopScrubbing;
window.addEventListener('pointerup',()=>setTimeout(stopScrubbing,0));

const timeline=$('seek').parentElement,seekPreview=$('seek-preview');
timeline.addEventListener('pointermove',event=>{
  const duration=Number.isFinite(movie.duration)?movie.duration:streamCatalog?.duration||0;
  if(!version||duration<=0)return;
  const {left,width}=timeline.getBoundingClientRect();
  if(width<=15)return;
  const offset=Math.max(0,Math.min(width,event.clientX-left));
  const ratio=Math.max(0,Math.min(1,(offset-7.5)/(width-15)));
  seekPreview.textContent=time(ratio*duration);
  seekPreview.style.left=Math.max(25,Math.min(width-25,offset))+'px';
  seekPreview.hidden=false;
});
timeline.addEventListener('pointerleave',()=>{seekPreview.hidden=true;});

movie.addEventListener('timeupdate',updateTime);
movie.addEventListener('loadedmetadata',()=>{
  sourceLoading=false;
  sourceFailed=false;
  syncPlayback(true);
  updateBufferDisplay();
  scheduleWatch();
});
movie.addEventListener('error',()=>{
  if(!version||!currentStream||streamPlayer)return;
  sourceLoading=false;
  sourceFailed=true;
  const source=mediaSource;
  useQuality(qualityPreference,true);
  if(mediaSource===source&&movie.error?.code===MediaError.MEDIA_ERR_NETWORK)retryMedia();
  updateBufferDisplay();
  scheduleWatch();
});
movie.addEventListener('loadeddata',()=>{mediaRetryCount=0;});
movie.addEventListener('ended',()=>{
  if(room?.video?.growing){mediaWaiting=true;scheduleWatch();return;}
  if(movie.ended&&!pendingSeek&&room?.playback.phase==='playing')writePlayback('ended',movie.duration,room.playback.sequence);
  scheduleWatch();
});
for(const event of ['play','pause','waiting','playing','seeking','seeked','canplay','progress'])movie.addEventListener(event,()=>{
  if(event==='pause'&&connected&&!sourceLoading&&!unlocking&&!movie.ended&&
    room?.playback.phase==='playing'&&serverNow()>=room.playback.at)heldPlayback=room.playback;
  if(event==='waiting')mediaWaiting=true;
  if(event==='playing'||(event==='canplay'||event==='seeked')&&movie.readyState>=3)mediaWaiting=false;
  if(event==='playing'&&room?.playback.phase==='playing'&&!unlocking)playedVersion=version;
  if(event==='seeked'||event==='canplay')syncPlayback();
  updateBufferDisplay();
  scheduleWatch();
});
$('enable-play').onclick=async()=>{
  if(unlocking)return;
  unlocking=true;
  try {
    await movie.play();
    autoplayBlocked=false;
  }catch{toast('Не удалось включить просмотр');}
  finally {
    unlocking=false;
    syncPlayback();
    updateBufferDisplay();
    scheduleWatch();
  }
};
$('mute').onclick=()=>{movie.muted=!movie.muted;$('mute').textContent=movie.muted?'⊘':'♪';};
$('volume').oninput=()=>{movie.volume=Number($('volume').value);movie.muted=false;$('mute').textContent='♪';};
$('quality').onchange=()=>{qualityPreference=$('quality').value;useQuality(qualityPreference);};

const player=$('player'),controls=player.querySelector('.controls');
function fullscreen(){return document.fullscreenElement===player||player.classList.contains('fullscreen-fallback');}
function hideFullscreenControls() {
  if(!fullscreen()||isScrubbing||participantsOpen||controls.querySelector(':focus-visible'))return;
  player.classList.add('idle-controls');
  seekPreview.hidden=true;
}
function showFullscreenControls() {
  clearTimeout(fullscreenTimer);
  player.classList.remove('idle-controls');
  if(fullscreen())fullscreenTimer=setTimeout(hideFullscreenControls,2200);
}
function fullscreenChanged() {
  refreshParticipantDrawer();
  $('fullscreen').setAttribute('aria-label',fullscreen()?'Выйти из полного экрана':'Полный экран');
}
$('fullscreen').onclick=async()=>{
  if(player.classList.contains('fullscreen-fallback')) {
    player.classList.remove('fullscreen-fallback');
    document.body.classList.remove('fullscreen-open');
    fullscreenChanged();
    return;
  }
  try {
    if(document.fullscreenElement===player)await document.exitFullscreen();
    else await player.requestFullscreen();
  }catch {
    player.classList.add('fullscreen-fallback');
    document.body.classList.add('fullscreen-open');
    fullscreenChanged();
  }
};
document.addEventListener('fullscreenchange',()=>{
  if(expandedScreen&&!expandedScreen.classList.contains('screen-fullscreen-fallback')&&document.fullscreenElement!==expandedScreen){expandedScreen.querySelector('.screen-expand')?.setAttribute('aria-label','Развернуть демонстрацию на весь экран');expandedScreen=null;screenReturn=null;}
  fullscreenChanged();
});
$('participants-toggle').onclick=()=>setParticipantsOpen(!participantsOpen);
$('participants-close').onclick=()=>setParticipantsOpen(false);
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&expandedScreen?.classList.contains('screen-fullscreen-fallback'))closeScreenFullscreen();});

player.addEventListener('pointermove',event=>{
  if(!fullscreen()||event.pointerType==='touch')return;
  const bottom=player.getBoundingClientRect().bottom;
  if(event.clientY>=bottom-115||!player.classList.contains('idle-controls'))showFullscreenControls();
});
player.addEventListener('pointerdown',event=>{
  if(fullscreen()&&(event.pointerType==='touch'||controls.contains(event.target)))showFullscreenControls();
});
controls.addEventListener('focusout',()=>{if(fullscreen())showFullscreenControls();});
movie.ondblclick=()=>$('fullscreen').click();
$('enable-audio').onclick=async()=>{const results=await Promise.allSettled([...cards.values(),...screenCards.values()].flatMap(card=>[...card.querySelectorAll('audio')]).map(audio=>audio.play()));$('enable-audio').hidden=results.every(result=>result.status==='fulfilled');};
$('mic-test').onclick=recordMicTest;
$('mic-processing').onchange=changeMicrophoneProcessing;
$('mute-call').onclick=()=>setCallMuted(!callMuted);
$('movie-mode').onclick=()=>setCallView(false);
$('call-mode').onclick=()=>setCallView(true);
$('call-focus').onchange=event=>{
  focusedTile=event.target.value===''?null:[...cards.values(),...screenCards.values()][Number(event.target.value)]||null;
  renderCallLayout();
};
$('share-screen').onclick=toggleScreenShare;
$('camera-window').onclick=toggleCameraWindow;
$('mic').onclick=()=>toggle('audio');$('camera').onclick=()=>toggle('video');$('chat-form').onsubmit=async e=>{e.preventDefault();const input=$('chat-input'),text=input.value.trim();if(!text)return;input.value='';try{await command('chat',{text});}catch(error){input.value=text;toast(error.message);}};
window.addEventListener('keydown',event=>{
  if(fullscreen()) {
    showFullscreenControls();
    if(event.key==='Escape'&&player.classList.contains('fullscreen-fallback'))$('fullscreen').click();
  }
  if(['INPUT','TEXTAREA','BUTTON','SELECT'].includes(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;
  if(event.code==='Space'&&host()&&version){event.preventDefault();requestPlayPause();}
  if(event.code==='ArrowRight'&&host()&&version){event.preventDefault();seekBy(10);}
  if(event.code==='ArrowLeft'&&host()&&version){event.preventDefault();seekTo(movie.currentTime-10);}
});
window.addEventListener('beforeunload',()=>{
  cameraWindow?.close();
  events?.close();
  for(const track of [...media.getTracks(),...(displayCapture?.getTracks()||[])])track.stop();
});
function resumeConnection() {
  if(!session)return;
  if(!connected||!events||events.readyState!==EventSource.OPEN||Date.now()-lastRoomEvent>12000) {
    clearTimeout(reconnectTimer);reconnectTimer=null;
    reconnect('heartbeat_timeout');
    return;
  }
  syncPlayback();scheduleWatch();
}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden)resumeConnection();
});
window.addEventListener('online',resumeConnection);
setInterval(()=>{if(events&&Date.now()-lastRoomEvent>12000)reconnect('heartbeat_timeout');if(version){syncPlayback();updateBufferDisplay();}},1000);
setInterval(()=>{if(connected)syncClock();},60000);
