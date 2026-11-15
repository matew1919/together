import http from 'node:http';
import {getIceConfig} from './ice-config.mjs';
import {prepareStreams,describeStreams,streamAsset,authenticatedPlaylist,cancelStreams} from './video-streams.mjs';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir, stat, unlink, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.DATA_DIR || path.join(root, '.data');
const maxBytes = Number(process.env.MAX_VIDEO_GB || 8) * 1024 ** 3;
const rooms = new Map();
function persistRooms() {
  const saved=[...rooms.values()].map(room=>({id:room.id,host:room.host,video:room.video,playback:room.playback,messages:room.messages,touched:room.touched,members:[...room.members.values()].map(({id,token,name})=>({id,token,name}))}));
  try{const file=path.join(data,'rooms.json');writeFileSync(file+'.tmp',JSON.stringify({rooms:saved}),{mode:0o600});renameSync(file+'.tmp',file);}catch{console.warn('Не удалось сохранить комнаты');}
}
const id = (bytes = 18) => randomBytes(bytes).toString('base64url');
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
class Fault extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 32768) throw new Fault(413, 'Слишком большой запрос'); }
  try { return JSON.parse(text || '{}'); } catch { throw new Fault(400, 'Некорректный JSON'); }
}
const roster = room => [...room.members.values()].map(({id,name}) => ({id,name}));
function snapshot(room) { return {host:room.host, members:roster(room), video:room.video && {name:room.video.name,version:room.video.version,size:room.video.size}, playback:room.playback, messages:room.messages}; }
function send(member, type, value) { member.stream?.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); }
function broadcast(room,type,value) { for (const member of room.members.values()) send(member,type,value);if(type==='state'||type==='playback')persistRooms(); }
function state(room) { broadcast(room,'state',snapshot(room)); }
function join(room,name) {
  if (room.members.size >= 8) throw new Fault(409,'В комнате уже 8 участников');
  const member = {id:id(9),token:id(),name:String(name || 'Друг').trim().slice(0,32) || 'Друг',stream:null};
  room.members.set(member.id,member); room.touched = Date.now();
  // Also expire abandoned joins which never open the event stream.
  member.timer = setTimeout(() => leave(room, member), 20000);
  return member;
}
function leave(room,member) {
  if (!room.members.has(member.id)) return;
  clearTimeout(member.timer); member.stream?.end(); room.members.delete(member.id); room.touched = Date.now();
  if (room.host === member.id) { room.host = room.members.keys().next().value || null; room.playback = {...room.playback,position:position(room),paused:true,at:Date.now()}; }
  state(room);
}
function position(room) { return room.playback.position + (room.playback.paused ? 0 : (Date.now()-room.playback.at)/1000); }
function authorize(req,url) {
  const room = rooms.get(url.pathname.split('/')[3]); if (!room) throw new Fault(404,'Комната не найдена. Создай новую.');
  const token = req.headers.authorization?.replace(/^Bearer /,'') || url.searchParams.get('token');
  const member = [...room.members.values()].find(m => m.token === token);
  if (!member) throw new Fault(401,'Войди в комнату заново');
  room.touched = Date.now(); return {room,member};
}
function requireHost(room,member) { if (room.host !== member.id) throw new Fault(403,'Плеером управляет ведущий'); }
async function removeVideo(video) { if (video) {await cancelStreams(video);await unlink(video.path).catch(()=>{});} }
export async function createApp() {
  await mkdir(data,{recursive:true});
  try {
    const saved=JSON.parse(readFileSync(path.join(data,'rooms.json'),'utf8'));
    for(const item of saved.rooms||[]) {
      if(!/^[\w-]+$/.test(item.id)||Date.now()-item.touched>86400000)continue;
      if(item.video&&path.dirname(item.video.path)!==path.resolve(data))continue;
      const room={...item,members:new Map(),uploading:false};
      for(const old of item.members||[]) {const member={...old,stream:null};member.timer=setTimeout(()=>leave(room,member),120000);room.members.set(member.id,member);}
      if(room.playback&&!room.playback.paused)room.playback={position:position(room),paused:true,at:Date.now()};
      rooms.set(room.id,room);
    }
  }catch(error){if(error.code!=='ENOENT')console.warn('Не удалось восстановить комнаты');}

  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    try {
      const url = new URL(req.url,'http://localhost');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new Fault(403,'Чужой источник запроса');
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res,200,{...await getIceConfig(data),maxBytes,maxMembers:8});
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        if (rooms.size >= 100) throw new Fault(503,'Слишком много комнат');
        const input = await body(req);
        const room = {id:id(12),members:new Map(),host:null,video:null,playback:{position:0,paused:true,at:Date.now()},messages:[],touched:Date.now(),uploading:false};
        const member = join(room,input.name); room.host = member.id; rooms.set(room.id,room);persistRooms();
        return json(res,201,{room:room.id,id:member.id,token:member.token});
      }
      const masterMatch=url.pathname.match(/^\/api\/rooms\/([\w-]+)\/hls\/([\w-]+)\/master\.m3u8$/);
      if(masterMatch&&req.method==='GET'){
        const {room}=authorize(req,url);const video=room.video;if(!video||video.version!==masterMatch[2])throw new Fault(404,'Видео изменилось');
        const readyVariants=describeStreams(video).variants.filter(variant=>variant.ready);const optimized=readyVariants.filter(variant=>variant.id!=='source'&&variant.height<=720);const variants=(optimized.length?optimized:readyVariants).sort((a,b)=>a.height-b.height);if(!variants.length)throw new Fault(409,'Поток ещё готовится');
        const token=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token');
        const master='#EXTM3U\n'+variants.map(variant=>'#EXT-X-STREAM-INF:BANDWIDTH='+({360:1100000,480:1900000,720:3500000,1080:6000000}[variant.height]||Math.round((variant.height/360)**1.7*1100000))+'\n'+variant.id+'/index.m3u8?token='+encodeURIComponent(token)).join('\n')+'\n';
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'private, no-store'});return res.end(master);
      }
      const hlsMatch=url.pathname.match(/^\/api\/rooms\/([\w-]+)\/hls\/([\w-]+)\/(source|\d+)\/(index\.m3u8|init\.mp4|part-\d{6}\.m4s)$/);
      if(hlsMatch&&(req.method==='GET'||req.method==='HEAD')) {
        const {room}=authorize(req,url);const video=room.video;
        if(!video||video.version!==hlsMatch[2])throw new Fault(404,'Видео изменилось');
        const asset=await streamAsset(video,hlsMatch[3],hlsMatch[4]);if(!asset)throw new Fault(404,'Качество ещё готовится');
        if(asset.playlist) {
          const token=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token');
          const playlist=authenticatedPlaylist(await readFile(asset.path,'utf8'),token);
          res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'private, no-store'});return res.end(req.method==='HEAD'?undefined:playlist);
        }
        res.writeHead(200,{'Content-Type':hlsMatch[4].endsWith('.m4s')?'video/iso.segment':'video/mp4','Content-Length':asset.size,'Cache-Control':'private, max-age=3600'});
        if(req.method==='HEAD')return res.end();const stream=createReadStream(asset.path);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);return;
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
            clearTimeout(member.timer);member.timer=setTimeout(()=>{if(!member.stream)leave(room,member);},60000);
            room.touched=Date.now();persistRooms();return json(res,200,{room:room.id,id:member.id,token:member.token});
          }
          const member = join(room,input.name); if (!room.host) room.host=member.id; state(room);
          return json(res,200,{room:room.id,id:member.id,token:member.token});
        }
        const {room,member} = authorize(req,url);
        if (req.method === 'GET' && action === 'events') {
          clearTimeout(member.timer); member.stream?.end();
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write(': connected\n\n'); member.stream=res; send(member,'state',snapshot(room)); state(room);
          const heartbeat = setInterval(()=>res.write(': ping\n\n'),15000);
          req.on('close',()=>{clearInterval(heartbeat); if(member.stream === res) {member.stream=null;if(rooms.get(room.id)===room&&room.members.has(member.id)) member.timer=setTimeout(()=>leave(room,member),60000);} }); return;
        }
        if(req.method==='GET'&&action==='media'){if(!room.video)throw new Fault(404,'Видео не выбрано');const video=room.video;const requested=url.searchParams.get('quality');if(requested&&!['360','480','720','1080'].includes(requested))throw new Fault(400,'Некорректное качество');prepareStreams(video,media=>broadcast(room,'media',{version:video.version,...media}),requested);return json(res,200,{version:video.version,...describeStreams(video)});}
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
        if (req.method === 'POST' && action === 'playback') {
          requireHost(room,member); const input = await body(req);
          if (!Number.isFinite(input.position)||input.position<0||typeof input.paused!=='boolean') throw new Fault(400,'Некорректная позиция');
          if (input.version !== room.video?.version) throw new Fault(409,'Видео уже изменилось');
          room.playback={position:Math.min(input.position,604800),paused:input.paused,at:Date.now()};
          broadcast(room,'playback',{...room.playback,version:room.video.version}); return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && action === 'host') {
          requireHost(room,member); const input=await body(req);
          if(!room.members.has(input.id)) throw new Fault(404,'Участник вышел');
          if(input.id===room.host)return json(res,200,{ok:true});
          room.playback={position:position(room),paused:true,at:Date.now()};
          room.host=input.id; state(room); return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && action === 'upload') {
          requireHost(room,member);
          if(room.uploading) throw new Fault(409,'Уже загружается видео');
          const size=Number(req.headers['content-length']);
          if (!size || size > maxBytes) throw new Fault(413,`Размер файла должен быть до ${Math.round(maxBytes/1024**3)} ГБ`);
          const name=decodeURIComponent(req.headers['x-file-name'] || 'Видео').slice(0,200);
          if(!/\.(mp4|webm|m4v|mov|mkv|ogg|ogv)$/i.test(name)) throw new Fault(400,'Выбери видеофайл');
          room.uploading=true;
          const filePath=path.join(data,`${id()}.video`); let bytes=0;
          try {
            await pipeline(req,new Transform({transform(chunk,encoding,cb) {bytes+=chunk.length;cb(bytes>maxBytes?new Error('Слишком большой файл'):null,chunk);}}),createWriteStream(filePath,{flags:'wx'}));
            if(bytes!==size) throw new Error('Файл загружен не полностью');
            if(room.host!==member.id) throw new Error('Ведущий сменился во время загрузки');
            const old=room.video;
            room.video={path:filePath,name,size:bytes,version:id(9),type:/\.webm$/i.test(name)?'video/webm':/\.og[gv]$/i.test(name)?'video/ogg':/\.mkv$/i.test(name)?'video/x-matroska':'video/mp4'};
            room.playback={position:0,paused:true,at:Date.now()}; state(room);const video=room.video;prepareStreams(video,media=>broadcast(room,'media',{version:video.version,...media}));await removeVideo(old);
            return json(res,200,{ok:true});
          } catch(error) {await unlink(filePath).catch(()=>{});throw error;} finally {room.uploading=false;}
        }
        if ((req.method === 'GET'||req.method === 'HEAD') && action === 'video') {
          const video=room.video; if(!video||url.searchParams.get('v')!==video.version) throw new Fault(404,'Видео не найдено');
          const headers={'Content-Type':video.type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store'};
          let start=0,end=video.size-1,status=200;
          if(req.headers.range) {
            const range=req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
            if(!range || (!range[1]&&!range[2])) {res.writeHead(416,{'Content-Range':`bytes */${video.size}`});return res.end();}
            if(!range[1]) start=Math.max(0,video.size-Number(range[2]));
            else {start=Number(range[1]);if(range[2]) end=Math.min(end,Number(range[2]));}
            if(start>end||start>=video.size) {res.writeHead(416,{'Content-Range':`bytes */${video.size}`});return res.end();}
            headers['Content-Range']=`bytes ${start}-${end}/${video.size}`; status=206;
          }
          headers['Content-Length']=end-start+1; res.writeHead(status,headers);
          if(req.method==='HEAD') return res.end();
          const stream=createReadStream(video.path,{start,end}); stream.on('error',()=>res.destroy()); res.on('close',()=>stream.destroy()); stream.pipe(res); return;
        }
        throw new Fault(404,'Не найдено');
      }
      if(req.method!=='GET'&&req.method!=='HEAD') throw new Fault(404,'Не найдено');
      const file = {'/':'index.html','/app.js':'app.js','/hls.min.js':'hls.min.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}[url.pathname];
      if(!file) throw new Fault(404,'Не найдено');
      const filePath=path.join(root,'public',file); const info=await stat(filePath);
      res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Content-Length':info.size,'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      if(req.method==='HEAD') res.end(); else createReadStream(filePath).pipe(res);
    } catch(error) { if(!res.headersSent&&!res.destroyed) json(res,error.status||500,{error:error.status?error.message:'Не удалось выполнить запрос'});else if(!res.destroyed) res.end(); }
  });
  server.requestTimeout=0;
  const checkpoint=setInterval(persistRooms,10000);checkpoint.unref();
  const cleanup=setInterval(()=>{for(const [key,room] of rooms) if(!room.members.size&&!room.uploading&&Date.now()-room.touched>3600000){rooms.delete(key);removeVideo(room.video);}},60000); cleanup.unref();
  server.on('close',()=>{persistRooms();clearInterval(checkpoint);clearInterval(cleanup);for(const room of rooms.values())for(const m of room.members.values()){clearTimeout(m.timer);const stream=m.stream;m.stream=null;stream?.end();}rooms.clear();});
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const server=await createApp(); const port=Number(process.env.PORT||3000);
  server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`Together → http://localhost:${port}`));
}
