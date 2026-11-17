import http from 'node:http';
import {createLiveSources} from './live-source.mjs';
import {localSourceControl} from './local-source-control.mjs';
import {getIceConfig} from './ice-config.mjs';
import {prepareStreams,describeStreams,streamAsset,authenticatedPlaylist} from './video-streams.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {openVideoLibrary,videoType} from './video-library.mjs';
import {playbackPosition,setPlayback,updateGroupPlayback,watchReady} from './playback.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const id = (bytes = 18) => randomBytes(bytes).toString('base64url');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const staticFiles=new Map(Object.entries({'/':'index.html','/app.js':'app.js','/hls.min.js':'hls.min.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}).map(([route,file])=>{
  const bytes=readFileSync(path.join(root,'public',file));
  const etag='W/"'+createHash('sha256').update(bytes).digest('base64url').slice(0,24)+'"';
  return [route,{bytes,gzip:gzipSync(bytes),etag,mime:mime[path.extname(file)]}];
}));
class Fault extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 32768) throw new Fault(413, 'Слишком большой запрос'); }
  try { return JSON.parse(text || '{}'); } catch { throw new Fault(400, 'Некорректный JSON'); }
}
const roster=room=>[...room.members.values()].map(({id,name,stream,present})=>({id,name,present:!!present,online:!!stream}));
function snapshot(room) {
  const video=room.video;
  return {host:room.host,members:roster(room),video:video&&{name:video.name,version:video.version,size:video.size,live:!!video.liveId,growing:!!video.growing},playback:room.playback,messages:room.messages};
}
function send(member,type,value) {
  member.stream?.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function libraryViewer(req) {
  const key=req.headers['x-library-key'];
  const local=/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress||'')&&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host||'')&&
    !req.headers.forwarded&&!req.headers['x-forwarded-for'];
  return {local,key:local?'local':/^[a-f0-9]{48}$/.test(key||'')?key:null};
}
function requireHost(room,member) {
  if(room.host!==member.id)throw new Fault(403,'Плеером управляет ведущий');
}

export async function createApp({publicOrigin=()=>process.env.PUBLIC_URL||null,sharing=false,server=http.createServer()}={}) {
  const data=path.resolve(process.env.DATA_DIR||path.join(root,'.data'));
  const maxBytes=Number(process.env.MAX_VIDEO_GB||8)*1024**3;
  const library=await openVideoLibrary(data);
  const live=createLiveSources(path.join(data,'live'),{maxBytes});
  const describeVideo=video=>video.liveId?live.describe(video):describeStreams(video);
  const rooms=new Map();
  const logs=path.join(data,'logs');
  mkdirSync(logs,{recursive:true,mode:0o700});
  let logWarning=false;
  function log(event,details={}) {
    const at=new Date().toISOString();
    try {
      appendFileSync(path.join(logs,at.slice(0,10)+'.jsonl'),
        JSON.stringify({at,event,...details})+'\n',{mode:0o600});
      logWarning=false;
    }catch {
      if(!logWarning)console.warn('Не удалось записать журнал Together');
      logWarning=true;
    }
  }
  log('server_started',{sharing});
  function persistRooms() {
    const now=Date.now();
    const saved=[...rooms.values()].map(room=>({
      id:room.id,host:room.host,
      video:room.video&&{assetId:room.video.assetId,liveId:room.video.liveId,version:room.video.version,name:room.video.name},
      playback:{...room.playback,position:playbackPosition(room.playback,now),at:now},
      messages:room.messages,touched:room.touched,
      members:[...room.members.values()].map(({id,token,name})=>({id,token,name}))
    }));
    try {
      const file=path.join(data,'rooms.json');
      writeFileSync(file+'.tmp',JSON.stringify({rooms:saved}),{mode:0o600});
      renameSync(file+'.tmp',file);
    }catch(error){log('rooms_save_error',{code:error.code});console.warn('Не удалось сохранить комнаты');}
  }

  function broadcast(room,type,value) {
    for(const member of room.members.values())send(member,type,value);
    if(type==='state'||type==='playback')persistRooms();
  }
  function state(room) {
    log('room_state',{room:room.id,host:room.host,version:room.video?.version,
      members:roster(room).map(({id,online})=>({id,online})),playback:room.playback});
    broadcast(room,'state',snapshot(room));
  }
  function playbackChanged(room,cause='group') {
    log('playback',{room:room.id,version:room.video.version,cause,...room.playback});
    broadcast(room,'playback',{...room.playback,version:room.video.version});
  }
  function advance(room) {
    if(room.video&&updateGroupPlayback(room))playbackChanged(room);
  }
  function leave(room,member,expired=false) {
    if(!room.members.delete(member.id))return;
    log('member_left',{room:room.id,member:member.id,reason:expired?'reconnect_timeout':member.present?'left':'join_timeout'});
    clearTimeout(member.timer);
    member.stream?.end();
    room.touched=Date.now();
    if(room.host===member.id) {
      room.host=room.members.keys().next().value||null;
      setPlayback(room,'paused',playbackPosition(room.playback));
    } else if(expired&&member.present&&room.playback.phase==='buffering') {
      setPlayback(room,'paused',room.playback.position);
    } else if(room.video)updateGroupPlayback(room);
    state(room);
  }
  function join(room,name) {
    if(room.members.size>=8)throw new Fault(409,'В комнате уже 8 участников');
    const member={id:id(9),token:id(),name:String(name||'Друг').trim().slice(0,32)||'Друг',stream:null};
    room.members.set(member.id,member);room.touched=Date.now();
    log('member_joined',{room:room.id,member:member.id});
    member.timer=setTimeout(()=>leave(room,member),20000);
    return member;
  }
  function authorize(req,url) {
    const room=rooms.get(url.pathname.split('/')[3]);if(!room)throw new Fault(404,'Комната не найдена. Создай новую.');
    const token=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token');
    const member=[...room.members.values()].find(m=>m.token===token);
    if(!member)throw new Fault(401,'Войди в комнату заново');
    room.touched=Date.now();
    req.togetherMember=member.id;
    return {room,member};
  }
  function ensureStreams(video,quality=null) {
    if(video.liveId)return;
    prepareStreams(video,media=>{
      for(const room of rooms.values()) {
        if(room.video?.path===video.path)broadcast(room,'media',{...media,version:room.video.version});
      }
    },quality);
  }
  function selectVideo(room,video) {
    if(room.video?.liveId)live.stop(room.video.liveId);
    room.video={...video,version:id(9)};
    setPlayback(room,'paused',0);
    state(room);
    ensureStreams(room.video);
  }

  try {
    const saved=JSON.parse(readFileSync(path.join(data,'rooms.json'),'utf8'));
    for(const item of saved.rooms||[]) {
      if(!/^[\w-]+$/.test(item.id))continue;
      const file=item.video?.liveId?await live.restore(item.video.liveId):item.video&&library.restore(item.video);
      if(Date.now()-item.touched>86400000)continue;
      const video=file?{...file,version:item.video.version}:null;
      const room={...item,video,members:new Map(),uploading:false};
      // Resume at the last saved position. Time spent offline does not advance the film.
      setPlayback(room,'paused',video?item.playback?.position||0:0);
      for(const old of item.members||[]) {
        const member={...old,stream:null};
        member.timer=setTimeout(()=>leave(room,member),120000);
        room.members.set(member.id,member);
      }
      rooms.set(room.id,room);
    }
  } catch(error) {
    if(error.code!=='ENOENT')console.warn('Не удалось восстановить комнаты');
  }
  server.on('request',async (req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const started=performance.now();
    let route,failure;
    function record(event) {
      log(event,{method:req.method,route,member:req.togetherMember,
        status:res.headersSent?res.statusCode:null,ms:Math.round(performance.now()-started),
        declaredBytes:res.getHeader('Content-Length'),failure});
    }
    res.once('finish',()=>record('http'));
    res.once('close',()=>{if(!res.writableFinished)record('http_interrupted');});
    try {
      const url = new URL(req.url,'http://localhost');
      route=url.pathname;
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== publicOrigin()) throw new Fault(403,'Чужой источник запроса');
      if(req.method==='GET'&&url.pathname==='/api/time')return json(res,200,{now:Date.now()});
      if(req.method==='GET'&&url.pathname==='/api/address')return json(res,200,{url:publicOrigin(),sharing});
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res,200,{...await getIceConfig(data),maxBytes,maxMembers:8,localSourceOwner:libraryViewer(req).local});
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        if (rooms.size >= 100) throw new Fault(503,'Слишком много комнат');
        const input = await body(req);
        const room = {id:id(12),members:new Map(),host:null,video:null,messages:[],touched:Date.now(),uploading:false};
        const member = join(room,input.name); room.host = member.id;setPlayback(room,'paused',0);rooms.set(room.id,room);persistRooms();
        return json(res,201,{room:room.id,id:member.id,token:member.token});
      }
      const masterMatch=url.pathname.match(/^\/api\/rooms\/([\w-]+)\/hls\/([\w-]+)\/master\.m3u8$/);
      if(masterMatch&&req.method==='GET'){
        const {room}=authorize(req,url);const video=room.video;if(!video||video.version!==masterMatch[2])throw new Fault(404,'Видео изменилось');
        ensureStreams(video);
        const readyVariants=describeVideo(video).variants.filter(variant=>variant.ready);const optimized=readyVariants.filter(variant=>variant.id!=='source'&&variant.height<=720);const variants=(optimized.length?optimized:readyVariants).sort((a,b)=>a.height-b.height);if(!variants.length)throw new Fault(409,'Поток ещё готовится');
        const token=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token');
        const master='#EXTM3U\n'+variants.map(variant=>'#EXT-X-STREAM-INF:BANDWIDTH='+({360:1100000,480:1900000,720:3500000,1080:6000000}[variant.height]||Math.round((variant.height/360)**1.7*1100000))+'\n'+variant.id+'/index.m3u8?token='+encodeURIComponent(token)).join('\n')+'\n';
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'private, no-store'});return res.end(master);
      }
      const hlsMatch=url.pathname.match(/^\/api\/rooms\/([\w-]+)\/hls\/([\w-]+)\/(source|\d+)\/(index\.m3u8|init\.mp4|part-\d{6,}\.m4s)$/);
      if(hlsMatch&&(req.method==='GET'||req.method==='HEAD')) {
        const {room}=authorize(req,url);const video=room.video;
        if(!video||video.version!==hlsMatch[2])throw new Fault(404,'Видео изменилось');
        ensureStreams(video);
        const asset=await (video.liveId?live.asset(video,hlsMatch[3],hlsMatch[4]):streamAsset(video,hlsMatch[3],hlsMatch[4]));if(!asset)throw new Fault(404,'Качество ещё готовится');
        if(asset.playlist) {
          const token=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token');
          const playlist=authenticatedPlaylist(await readFile(asset.path,'utf8'),token);
          res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'private, no-store'});return res.end(req.method==='HEAD'?undefined:playlist);
        }
        res.writeHead(200,{'Content-Type':hlsMatch[4].endsWith('.m4s')?'video/iso.segment':'video/mp4','Content-Length':asset.size,'Cache-Control':'private, max-age=3600'});
        if(req.method==='HEAD')return res.end();const stream=createReadStream(asset.path);res.on('close',()=>stream.destroy());stream.on('error',error=>{failure=error.code||'read_error';res.destroy();});stream.pipe(res);return;
      }
      const match = url.pathname.match(/^\/api\/rooms\/([\w-]+)\/(\w+)$/);
      if (match) {
        const action = match[2];
        if (req.method === 'POST' && action === 'join') {
          const room = rooms.get(match[1]); if (!room) throw new Fault(404,'Комната не найдена. Создай новую.');
          const input = await body(req);
          if(input.token){
            const member=[...room.members.values()].find(member=>member.token===input.token);
            if(!member)throw new Fault(401,'Сессия истекла');
            clearTimeout(member.timer);member.timer=setTimeout(()=>{if(!member.stream)leave(room,member,true);},60000);
            log('member_resumed',{room:room.id,member:member.id});
            room.touched=Date.now();persistRooms();return json(res,200,{room:room.id,id:member.id,token:member.token});
          }
          const member = join(room,input.name); if (!room.host) room.host=member.id; state(room);
          return json(res,200,{room:room.id,id:member.id,token:member.token});
        }
        const {room,member} = authorize(req,url);
        if(req.method==='GET'&&action==='events') {
          clearTimeout(member.timer);
          const previous=member.stream;
          member.stream=res;
          member.present=true;
          log('events_connected',{room:room.id,member:member.id,replaced:!!previous});
          member.watch=null;
          previous?.end();
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write(': connected\n\n');
          if(!previous&&room.playback.phase==='playing')setPlayback(room,'buffering',playbackPosition(room.playback));
          state(room);
          const heartbeat=setInterval(()=>send(member,'heartbeat',null),4000);
          res.on('close',()=>{
            clearInterval(heartbeat);
            if(member.stream!==res||!rooms.has(room.id)||!room.members.has(member.id))return;
            member.stream=null;
            log('events_disconnected',{room:room.id,member:member.id,lastWatchMs:member.watch?Date.now()-member.watch.at:null});
            member.timer=setTimeout(()=>leave(room,member,true),60000);
            if(room.video)updateGroupPlayback(room);
            state(room);
          });
          return;
        }
        if(req.method==='POST'&&action==='clientevent') {
          const {reason}=await body(req);
          if(typeof reason==='string'&&/^(events_closed|heartbeat_timeout|watch_(network|[0-9]{3}))$/.test(reason)) {
            log('client_reconnected',{room:room.id,member:member.id,reason});
          }
          return json(res,200,{ok:true});
        }
        if(req.method==='HEAD'&&action==='session'){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
        if(req.method==='GET'&&action==='media') {
          const video=room.video;
          if(!video)throw new Fault(404,'Видео не выбрано');
          const requested=url.searchParams.get('quality');
          if(requested&&!/^\d{1,4}$/.test(requested))throw new Fault(400,'Некорректное качество');
          ensureStreams(video,requested);
          return json(res,200,{...describeVideo(video),version:video.version});
        }
        if(req.method==='GET'&&action==='library') {
          requireHost(room,member);
          return json(res,200,{videos:library.list(libraryViewer(req))});
        }
        if(req.method==='POST'&&action==='select') {
          const input=await body(req);
          requireHost(room,member);
          if(room.uploading)throw new Fault(409,'Идёт загрузка видео');
          const video=library.select(input.id,libraryViewer(req));
          if(!video)throw new Fault(404,'Видео не найдено в библиотеке');
          selectVideo(room,video);
          return json(res,200,{ok:true});
        }
        if(req.method==='POST'&&action==='watch') {
          const {version,sequence,position,duration,bufferAhead,waiting,blocked,paused}=await body(req);
          if(!member.stream||!room.video)return json(res,200,{ok:true});
          if(version!==room.video.version||sequence!==room.playback.sequence) {
            return json(res,200,{ok:true,playback:{...room.playback,version:room.video.version}});
          }
          if([position,duration,bufferAhead].some(value=>!Number.isFinite(value)||value<0)||[waiting,blocked,paused].some(value=>typeof value!=='boolean'))throw new Fault(400,'Некорректное состояние плеера');
          member.watch={version,sequence,position,duration,bufferAhead,waiting,blocked,paused,at:Date.now()};
          broadcast(room,'watch',{id:member.id,...member.watch,ready:watchReady(room.playback,member.watch,Date.now(),room.video.growing)});
          advance(room);
          return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && action === 'leave') { leave(room,member); return json(res,200,{ok:true}); }
        if (req.method === 'POST' && action === 'signal') {
          const input = await body(req); const target = room.members.get(input.to);
          if (target && input.signal && typeof input.signal === 'object') send(target,'signal',{from:member.id,signal:input.signal});
          return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && action === 'chat') {
          const input = await body(req); const text = String(input.text||'').trim().slice(0,1000);
          if (!text) throw new Fault(400,'Пустое сообщение');
          if(Date.now()-(member.lastMessage||0)<500) throw new Fault(429,'Слишком много сообщений'); member.lastMessage=Date.now();
          const message = {id:id(8),from:member.id,name:member.name,text,at:Date.now()};
          room.messages.push(message); room.messages=room.messages.slice(-80); broadcast(room,'chat',message); return json(res,200,{ok:true});
        }
        if(req.method==='POST'&&action==='playback') {
          const input=await body(req);
          requireHost(room,member);
          if(!room.video||input.version!==room.video.version)throw new Fault(409,'Видео уже изменилось');
          const legacy=!input.action&&typeof input.paused==='boolean';
          const operation=legacy?(input.paused?'pause':'play'):input.action;
          const {phase}=room.playback;
          const current=playbackPosition(room.playback);
          if(legacy||['seek','ended'].includes(operation)||input.position!==undefined) {
            if(!Number.isFinite(input.position)||input.position<0||input.position>604800)throw new Fault(400,'Некорректная позиция');
          }
          if(operation==='pause')setPlayback(room,'paused',legacy?input.position:current);
          else if(operation==='play'&&phase==='paused')setPlayback(room,'buffering',input.position??current);
          else if(operation==='seek')setPlayback(room,phase==='paused'?'paused':'buffering',input.position);
          else if(operation==='ended'&&phase==='playing'&&(input.sequence===undefined||input.sequence===room.playback.sequence))setPlayback(room,'paused',input.position);
          else if(!['play','ended'].includes(operation))throw new Fault(400,'Некорректная команда плеера');
          playbackChanged(room,operation);
          return json(res,200,{...room.playback,version:room.video.version});
        }
        if(req.method==='POST'&&action==='host') {
          const input=await body(req);
          requireHost(room,member);
          if(!room.members.has(input.id))throw new Fault(404,'Участник вышел');
          if(input.id===room.host)return json(res,200,{ok:true});
          setPlayback(room,'paused',playbackPosition(room.playback));
          room.host=input.id;
          state(room);
          return json(res,200,{ok:true});
        }
        if(req.method==='POST'&&action==='upload') {
          requireHost(room,member);
          if(room.uploading)throw new Fault(409,'Уже загружается видео');
          const size=Number(req.headers['content-length']);
          if(!Number.isSafeInteger(size)||size<1||size>maxBytes)throw new Fault(413,`Размер файла должен быть до ${Math.round(maxBytes/1024**3)} ГБ`);
          let name;
          try{name=decodeURIComponent(req.headers['x-file-name']||'').slice(0,200);}catch{throw new Fault(400,'Некорректное имя файла');}
          const type=videoType(name);
          if(!type)throw new Fault(400,'Выбери видеофайл');
          const viewer=libraryViewer(req);
          room.uploading=true;
          try {
            const video=await library.save(req,{size,name,type,owner:viewer.key||'local',checkOwner:()=>requireHost(room,member)});
            requireHost(room,member);
            selectVideo(room,video);
            return json(res,200,{ok:true});
          } finally {room.uploading=false;}
        }
        if ((req.method === 'GET'||req.method === 'HEAD') && action === 'video') {
          if(room.video?.liveId)throw new Fault(409,'Этот источник доступен только через потоковый плеер');
          const video=room.video; if(!video||url.searchParams.get('v')!==video.version) throw new Fault(404,'Видео не найдено');
          const headers={'Content-Type':video.type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600'};
          let start=0,end=video.size-1,status=200;
          if(req.headers.range) {
            const range=req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
            if(!range || (!range[1]&&!range[2])) {res.writeHead(416,{'Content-Range':`bytes */${video.size}`});return res.end();}
            if(!range[1]) start=Math.max(0,video.size-Number(range[2]));
            else {start=Number(range[1]);if(range[2]) end=Math.min(end,Number(range[2]));}
            // Keep each partial response below the public relay's body limit.
            if(/^[a-z0-9-]+\.tunnl\.gg(?::\d+)?$/i.test(req.headers.host||'')) {
              end=Math.min(end,start+16*1024**2-1);
            }
            if(start>end||start>=video.size) {res.writeHead(416,{'Content-Range':`bytes */${video.size}`});return res.end();}
            headers['Content-Range']=`bytes ${start}-${end}/${video.size}`; status=206;
          }
          headers['Content-Length']=end-start+1; res.writeHead(status,headers);
          if(req.method==='HEAD') return res.end();
          const stream=createReadStream(video.path,{start,end}); stream.on('error',error=>{failure=error.code||'read_error';res.destroy();}); res.on('close',()=>stream.destroy()); stream.pipe(res); return;
        }
        throw new Fault(404,'Не найдено');
      }
      if(req.method!=='GET'&&req.method!=='HEAD') throw new Fault(404,'Не найдено');
      const file=staticFiles.get(url.pathname);
      if(!file)throw new Fault(404,'Не найдено');
      const cache={'Cache-Control':'no-cache',Vary:'Accept-Encoding',ETag:file.etag};
      if(req.headers['if-none-match']===file.etag){res.writeHead(304,cache);res.end();return;}
      const gzip=/(?:^|,\s*)gzip(?:\s*,|\s*$)/i.test(req.headers['accept-encoding']||'');
      const bytes=gzip?file.gzip:file.bytes;
      res.writeHead(200,{...cache,'Content-Type':file.mime,'Content-Length':bytes.length,...(gzip?{'Content-Encoding':'gzip'}:{}),
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(req.method==='HEAD'?undefined:bytes);
    } catch(error) { failure=error.status||error.code||error.name; if(!res.headersSent&&!res.destroyed) json(res,error.status||500,{error:error.status?error.message:'Не удалось выполнить запрос'});else if(!res.destroyed) res.end(); }
  });
  server.on('diagnostic',log);
  server.requestTimeout=0;
  const cleanup=setInterval(()=>{
    const now=Date.now();
    let changed=false;
    for(const [key,room] of rooms) {
      if(!room.members.size&&!room.uploading&&now-room.touched>3600000){if(room.video?.liveId)live.stop(room.video.liveId);rooms.delete(key);changed=true;}
    }
    if(changed)persistRooms();
  },60000);
  cleanup.unref();
  const playbackCheck=setInterval(()=>{for(const room of rooms.values())advance(room);},1000);
  playbackCheck.unref();
  const checkpoint=setInterval(persistRooms,10000);
  checkpoint.unref();
  const sourceControl=await localSourceControl(data,{
    rooms:()=>[...rooms.values()].map(room=>({id:room.id,names:[...room.members.values()].map(member=>member.name),video:room.video?.name||null})),
    async start(input){
      const room=rooms.get(String(input.room));if(!room)throw new Error('Комната не найдена. Сначала создай комнату в браузере.');
      if(room.uploading)throw new Error('Подожди завершения текущей загрузки');
      if(room.video?.liveId)live.stop(room.video.liveId);
      const video=await live.start(String(input.file||''),(updated,media)=>{
        if(room.video?.liveId!==updated.liveId)return;
        room.video={...room.video,...updated};
        if(media.error)setPlayback(room,'paused',playbackPosition(room.playback));
        state(room);broadcast(room,'media',{...media,version:room.video.version});
        advance(room);
      });
      room.video={...video,version:id(9)};setPlayback(room,'paused',0);state(room);
      return {id:video.liveId,name:video.name};
    },
    status:id=>live.describe({liveId:id}),finish:id=>live.finish(id),stop:id=>live.stop(id)
  });
  server.on('close',()=>{
    sourceControl.close();live.close().catch(()=>{});
    log('server_stopped');
    persistRooms();clearInterval(checkpoint);clearInterval(cleanup);clearInterval(playbackCheck);
    for(const room of rooms.values())for(const member of room.members.values()) {
      clearTimeout(member.timer);
      const stream=member.stream;
      member.stream=null;
      stream?.end();
    }
    rooms.clear();
  });
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const server=await createApp(); const port=Number(process.env.PORT||3000);
  server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`Together → http://localhost:${server.address().port}`));
}
