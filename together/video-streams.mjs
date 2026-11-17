import {spawn} from 'node:child_process';
import {mkdir,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';

const jobs=new Map();
let chain=Promise.resolve();
const segmentPattern=/^part-\d{6,}\.m4s$/;
const bitrates={360:650,480:1300,720:2800,1080:5000};

function run(command,args,job) {
  return new Promise((resolve,reject)=>{
    const linux=process.platform==='linux';
    const child=spawn(linux?'nice':command,linux?['-n','15',command,...args]:args,{stdio:['ignore','pipe','pipe']});
    job.child=child;
    let output='',errors='';
    child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk;});
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
    child.once('error',reject);
    child.once('close',code=>{
      if(job.child===child)job.child=null;
      if(code===0)resolve(output);
      else reject(new Error(errors||'Video processing failed'));
    });
  });
}

export function describeStreams(video) {
  const job=jobs.get(video.path);
  if(!job)return {status:'pending',variants:[]};
  return {
    status:job.status,revision:job.revision,duration:job.duration,error:job.error||null,
    variants:job.variants.map(({id,height,bandwidth,ready,failed,processing})=>({
      id,height,bandwidth,ready,failed,processing:!!processing,requested:job.requests.has(id)
    }))
  };
}

async function completeVariant(directory) {
  try {
    const playlist=await readFile(path.join(directory,'index.m3u8'),'utf8');
    const segments=playlist.split(/\r?\n/).filter(line=>segmentPattern.test(line));
    if(!playlist.includes('#EXT-X-ENDLIST')||!segments.length)return false;
    const [init,first,last]=await Promise.all(['init.mp4',segments[0],segments.at(-1)].map(file=>stat(path.join(directory,file))));
    // A segment must contain media beyond the 24-byte styp header.
    return init.size>24&&first.size>24&&last.size>24;
  }catch{return false;}
}

async function inspectStreams(job) {
  const info=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',job.video.path],job));
  const track=info.streams.find(stream=>stream.codec_type==='video'&&!stream.disposition?.attached_pic);
  if(!track)throw new Error('No video track');
  const audio=info.streams.find(stream=>stream.codec_type==='audio');
  job.videoTrack=track.index;
  job.duration=Number(info.format.duration);
  const height=Number(track.height);
  const canRemux=track.codec_name==='h264'&&track.pix_fmt==='yuv420p'&&(!audio||audio.codec_name==='aac');
  const heights=[360,480,720,1080].filter(value=>value<=height);
  if(!heights.length)heights.push(Math.max(2,Math.floor(height/2)*2));
  job.variants=heights.map(value=>({id:String(value),height:value,bandwidth:((bitrates[value]||900)+160)*1000,ready:false,failed:false}));
  job.requests.add(job.variants[0].id);
  if(canRemux) {
    job.variants.unshift({id:'source',height,bandwidth:Number(info.format.bit_rate)||Math.round((height/360)**1.7*1300000),ready:false,failed:false});
    job.requests.add('source');
  }
  await Promise.all(job.variants.map(async variant=>{
    variant.ready=await completeVariant(path.join(job.directory,variant.id));
  }));
}

async function encodeVariant(job,variant) {
  const directory=path.join(job.directory,variant.id);
  await mkdir(directory,{recursive:true});
  if(job.cancelled)return;
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_threads','2',
    '-i',job.video.path,'-map','0:'+job.videoTrack,'-map','0:a:0?','-sn','-dn'];
  if(variant.id==='source')args.push('-c','copy');
  else {
    const rate=bitrates[variant.height]||900;
    args.push('-vf',`scale=-2:${variant.height}`,'-c:v','libx264','-preset','superfast','-crf','26',
      '-maxrate',rate+'k','-bufsize',rate*2+'k','-threads','2','-pix_fmt','yuv420p','-sc_threshold','0',
      '-force_key_frames','expr:gte(t,n_forced*4)','-flags','+cgop','-c:a','aac','-b:a','128k','-ac','2');
  }
  args.push('-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_flags','temp_file+independent_segments',
    '-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4',
    '-hls_segment_filename',path.join(directory,'part-%06d.m4s'),path.join(directory,'index.m3u8'));
  await run('ffmpeg',args,job);
  if(!job.cancelled&&!await completeVariant(directory))throw new Error('Incomplete HLS segments');
}

export function prepareStreams(video,onChange=()=>{},quality=null) {
  let job=jobs.get(video.path);
  if(!job) {
    job={video,directory:video.path+'.hls',status:'queued',revision:0,variants:[],requests:new Set()};
    jobs.set(video.path,job);
  }
  job.onChange=onChange;
  if(quality)job.requests.add(String(quality));
  const needsWork=variant=>job.requests.has(variant.id)&&!variant.ready&&!variant.failed;
  if(job.active||job.inspected&&!job.variants.some(needsWork))return;
  job.active=true;
  const notify=()=>{if(!job.cancelled){job.revision++;job.onChange(describeStreams(video));}};
  const process=async()=>{
    if(job.cancelled)return;
    job.status='processing';
    notify();
    try {
      if(!job.inspected)await inspectStreams(job);
      while(!job.cancelled) {
        const variant=job.variants.find(needsWork);
        if(!variant)break;
        variant.processing=true;
        notify();
        try {
          await encodeVariant(job,variant);
          variant.ready=!job.cancelled;
        } catch {
          variant.failed=true;
        }
        variant.processing=false;
        notify();
      }
      job.status=job.variants.some(variant=>variant.ready)?'ready':'failed';
      if(job.status==='failed')job.error='Не удалось подготовить HLS. Проверь версию FFmpeg.';
    } catch {
      job.status='failed';
      job.error='Обработка видео недоступна. Попробуй воспроизвести исходный файл.';
    } finally {
      job.inspected=true;
      job.active=false;
      notify();
    }
  };
  job.task=chain=chain.catch(()=>{}).then(process);
}

export async function streamAsset(video,quality,file) {
  const job=jobs.get(video.path);
  const variant=job?.variants.find(item=>item.id===quality&&item.ready);
  if(!variant||(file!=='index.m3u8'&&file!=='init.mp4'&&!segmentPattern.test(file)))return null;
  const filePath=path.join(job.directory,quality,file);
  const info=await stat(filePath).catch(()=>null);
  return info?{path:filePath,size:info.size,playlist:file==='index.m3u8'}:null;
}
export function authenticatedPlaylist(text,token) {
  const query='?token='+encodeURIComponent(token);
  return text.split(/\r?\n/).map(line=>line.startsWith('#')?
    line.replace(/URI="([^"?]+)"/g,(_,uri)=>`URI="${uri}${query}"`):line.trim()?line+query:line).join('\n');
}
export async function cancelStreams(video) {
  const job=jobs.get(video.path);
  if(!job)return;
  job.cancelled=true;
  job.child?.kill('SIGTERM');
  await job.task;
  jobs.delete(video.path);
  await rm(job.directory,{recursive:true,force:true});
}
export async function waitForStreams(){await chain;}
