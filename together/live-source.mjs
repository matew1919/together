import {spawn} from 'node:child_process';
import {mkdir,open,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {followFile} from './growing-file.mjs';

export async function prefixFormat(handle) {
  const header=Buffer.alloc(16);const {bytesRead}=await handle.read(header,0,16,0);
  if(bytesRead<12)return null;
  if(header.readUInt32BE(0)===0x1a45dfa3)return 'matroska';
  if(header[0]===0x47)return 'mpegts';
  if(header.toString('ascii',4,8)!=='ftyp')throw new Error('Начало файла пока не похоже на MP4, MKV/WebM или MPEG-TS. Нужна последовательная загрузка.');
  const size=(await handle.stat()).size;
  let offset=0;
  for(let i=0;i<64;i++) {
    const box=Buffer.alloc(16);const read=await handle.read(box,0,16,offset);if(read.bytesRead<8)return null;
    const type=box.toString('ascii',4,8);let length=box.readUInt32BE(0);
    if(type==='moov')return 'mov';
    if(type==='mdat')throw new Error('У этого MP4 индекс находится после видеоданных. Смотреть его до конца скачивания через этот режим нельзя.');
    if(length===1){if(read.bytesRead<16)return null;const large=box.readBigUInt64BE(8);if(large>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Некорректный MP4');length=Number(large);}
    if(length<8)throw new Error('Неподдерживаемая структура MP4');
    offset+=length;if(offset+8>size)return null;
  }
  throw new Error('Не удалось найти индекс MP4 в начале файла');
}

export function createLiveSources(directory,{maxBytes=8*1024**3}={}) {
  const jobs=new Map();
  const descriptor=job=>({liveId:job.id,path:job.directory,name:job.name,size:job.bytes||0,type:'video/mp4',live:true,growing:!job.complete});
  function describe(video) {
    const job=jobs.get(video.liveId);
    if(!job)return {status:'failed',live:true,growing:false,error:'Источник прерван. Запусти файл сервера ещё раз.',variants:[]};
    return {status:job.error?'failed':job.complete?'ready':'processing',live:true,growing:!job.complete,duration:job.duration||0,error:job.error||null,revision:job.revision,variants:[{id:'360',height:360,bandwidth:950000,ready:!!job.ready,processing:!job.complete&&!job.error,requested:true}]};
  }
  const notify=job=>{job.revision++;job.onChange?.(descriptor(job),describe({liveId:job.id}));};
  async function inspect(job) {
    try {
      const text=await readFile(path.join(job.directory,'360','index.m3u8'),'utf8');
      const segments=text.split(/\r?\n/).filter(line=>/^part-\d+\.m4s$/.test(line));
      if(!segments.length)return;
      const info=await stat(path.join(job.directory,'360',segments[0]));if(info.size<=24)return;
      job.ready=true;job.duration=[...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((sum,match)=>sum+Number(match[1]),0);
      if(job.lastPlaylist!==text){job.lastPlaylist=text;notify(job);}
    }catch{}
  }
  async function process(job,handle) {
    let timer,child,childFailure;
    try {
      let format;
      while(!(format=await prefixFormat(handle))){if(job.finished)throw new Error('Файл пуст или в начале ещё нет метаданных видео');await delay(250,undefined,{signal:job.abort.signal});}
      const folder=path.join(job.directory,'360');await mkdir(folder,{recursive:true});
      const args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_threads','2','-probesize','1000000','-analyzeduration','1000000','-f',format,'-i','pipe:0','-map','0:v:0','-map','0:a:0?','-sn','-dn','-vf',"scale=-2:'min(360,ih)'",'-c:v','libx264','-preset','superfast','-crf','26','-maxrate','800k','-bufsize','1600k','-threads','2','-pix_fmt','yuv420p','-sc_threshold','0','-force_key_frames','expr:gte(t,n_forced*2)','-c:a','aac','-b:a','96k','-ac','2','-f','hls','-hls_time','2','-hls_playlist_type','event','-hls_list_size','0','-hls_flags','temp_file+independent_segments','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(folder,'part-%06d.m4s'),path.join(folder,'index.m3u8')];
      child=job.child=spawn('ffmpeg',args,{stdio:['pipe','ignore','pipe']});child.stderr.resume();
      const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('FFmpeg не смог прочитать этот незавершённый файл. Проверь последовательность загрузки и формат.')));});
      // Install the rejection handler immediately, even if input is still arriving.
      exited.catch(error=>{childFailure=error;job.abort.abort();});
      child.stdin.on('error',()=>job.abort.abort());
      timer=setInterval(()=>inspect(job),250);
      for await(const chunk of followFile(job.file,{handle,finished:()=>job.finished,signal:job.abort.signal,maxBytes,pollMs:100})) {
        job.bytes+=chunk.length;
        if(!child.stdin.write(chunk))await new Promise((resolve,reject)=>{const drain=()=>{cleanup();resolve();},error=err=>{cleanup();reject(err);};function cleanup(){child.stdin.off('drain',drain);child.stdin.off('error',error);}child.stdin.once('drain',drain);child.stdin.once('error',error);});
      }
      handle=null;child.stdin.end();await exited;await inspect(job);
      if(!job.ready)throw new Error('Не удалось получить видеофрагменты из файла');
      job.complete=true;
      await writeFile(path.join(job.directory,'source.json'),JSON.stringify({id:job.id,name:job.name,bytes:job.bytes,complete:true,duration:job.duration}),{mode:0o600});notify(job);
    }catch(error){job.error=job.stopping?'Источник остановлен владельцем сервера':childFailure?.code==='ENOENT'?'На компьютере сервера не найден FFmpeg. Установи FFmpeg и повтори.':childFailure?childFailure.message:error.name==='AbortError'?'Чтение источника прервалось. Запусти источник заново.':error.message;notify(job);}
    finally{clearInterval(timer);child?.stdin.destroy();if(child?.exitCode===null)child.kill('SIGTERM');await handle?.close().catch(()=>{});job.child=null;}
  }
  async function start(file,onChange) {
    if([...jobs.values()].filter(job=>!job.complete&&!job.error).length>=2)throw new Error('Одновременно можно передавать не больше двух растущих файлов');
    if(!path.isAbsolute(file))throw new Error('Укажи полный путь к файлу');
    const handle=await open(file,'r');const info=await handle.stat();
    if(!info.isFile()||info.size>maxBytes){await handle.close();throw new Error('Нужен обычный видеофайл не больше лимита загрузки');}
    if(info.size>4*1024**2&&typeof info.blocks==='number'&&info.blocks*512<info.size*.9){await handle.close();throw new Error('Файл содержит незаполненные участки. Включи последовательную загрузку.');}
    const id=randomBytes(12).toString('base64url');const job={id,file,name:path.basename(file),directory:path.join(directory,id),bytes:0,revision:0,finished:false,complete:false,ready:false,abort:new AbortController(),onChange};
    await mkdir(job.directory,{recursive:true});jobs.set(id,job);job.task=process(job,handle);return descriptor(job);
  }
  async function restore(id) {
    if(!/^[\w-]+$/.test(id))return null;
    if(jobs.has(id))return descriptor(jobs.get(id));
    const folder=path.join(directory,id);
    try{const value=JSON.parse(await readFile(path.join(folder,'source.json'),'utf8'));if(!value.complete)return null;const text=await readFile(path.join(folder,'360','index.m3u8'),'utf8');if(!text.includes('#EXT-X-ENDLIST'))return null;const job={...value,directory:folder,ready:true,revision:1};jobs.set(id,job);return descriptor(job);}catch{return null;}
  }
  async function asset(video,quality,file) {
    const job=jobs.get(video.liveId);if(!job?.ready||quality!=='360'||!/^index\.m3u8$|^init\.mp4$|^part-\d+\.m4s$/.test(file))return null;
    const filePath=path.join(job.directory,'360',file),info=await stat(filePath).catch(()=>null);return info?{path:filePath,size:info.size,playlist:file==='index.m3u8',live:!job.complete}:null;
  }
  function finish(id){const job=jobs.get(id);if(!job)throw new Error('Источник не найден');job.finished=true;return describe({liveId:id});}
  function stop(id){const job=jobs.get(id);if(job?.abort&&!job.complete){job.stopping=true;job.abort.abort();job.child?.stdin.destroy();job.child?.kill('SIGTERM');}}
  async function close(){for(const job of jobs.values())stop(job.id);await Promise.allSettled([...jobs.values()].map(job=>job.task));}
  return {start,describe,restore,asset,finish,stop,close,wait:id=>jobs.get(id)?.task};
}
