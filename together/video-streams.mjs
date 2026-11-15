import {spawn} from 'node:child_process';
import {mkdir,readFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
const jobs=new Map();
let chain=Promise.resolve();
function run(command,args,job){return new Promise((resolve,reject)=>{const child=spawn(process.platform==='linux'?'nice':command,process.platform==='linux'?['-n','15',command,...args]:args,{stdio:['ignore','pipe','pipe']});job.child=child;let output='',errors='';child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk;});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});child.once('error',reject);child.once('close',code=>{if(job.child===child)job.child=null;code===0?resolve(output):reject(new Error(errors||'Video processing failed'));});});}
export function describeStreams(video){const job=jobs.get(video.version);return job?{status:job.status,duration:job.duration,variants:job.variants.map(({id,height,ready,failed,processing})=>({id,height,ready,failed,processing:!!processing,requested:id==='source'||height===job.lowest||job.requests.has(id)})),error:job.error||null}:{status:'pending',variants:[]};}
export function prepareStreams(video,onChange=()=>{},quality=null,requests=null){
 const existing=jobs.get(video.version);
 if(existing){
  if(!quality)return;
  existing.requests.add(String(quality));
  const variant=existing.variants.find(v=>v.id===String(quality));
  if(!variant||variant.ready||!['ready','failed'].includes(existing.status))return;
  requests=new Set(existing.requests);jobs.delete(video.version);
 }
 const job={status:'queued',variants:[],requests:requests||new Set(quality?[String(quality)]:[]),directory:video.path+'.hls',cancelled:false};jobs.set(video.version,job);
 const notify=()=>{if(!job.cancelled)onChange(describeStreams(video));};
 chain=chain.catch(()=>{}).then(async()=>{
  if(job.cancelled)return;
  job.status='processing';notify();
  try{
   const info=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',video.path],job));
   const track=info.streams.find(stream=>stream.codec_type==='video');if(!track)throw new Error('No video track');
   job.duration=Number(info.format.duration);const height=Number(track.height);const audio=info.streams.find(stream=>stream.codec_type==='audio');
   const canRemux=track.codec_name==='h264'&&(!audio||audio.codec_name==='aac');
   job.variants=[];
   if(canRemux)job.variants.push({id:'source',height,copy:true,ready:false,failed:false});
   for(const h of [360,480,720,1080].filter(h=>h<=height))job.variants.push({id:String(h),height:h,ready:false,failed:false});
   if(!job.variants.length)job.variants.push({id:String(Math.max(144,height)),height:Math.max(144,height),ready:false,failed:false});
   job.lowest=Math.min(...job.variants.filter(v=>!v.copy).map(v=>v.height));
   await mkdir(job.directory,{recursive:true});notify();
   for(const variant of job.variants){
    if(job.cancelled)return;
    const directory=path.join(job.directory,variant.id);await mkdir(directory,{recursive:true});
    try {
      const playlist=await readFile(path.join(directory,'index.m3u8'),'utf8');
      const duration=[...playlist.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((sum,match)=>sum+Number(match[1]),0);
      if(playlist.includes('#EXT-X-ENDLIST')&&Math.abs(duration-job.duration)<2){variant.ready=true;notify();continue;}
    }catch{}
    if(!variant.copy&&variant.height!==job.lowest&&!job.requests.has(variant.id))continue;
    variant.processing=true;notify();
    const args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_threads','2','-i',video.path,'-map','0:v:0','-map','0:a:0?','-sn','-dn'];
    if(variant.copy)args.push('-c','copy');
    else args.push('-vf',`scale=-2:${variant.height}`,'-c:v','libx264','-preset','superfast','-crf','26','-maxrate',({360:'900k',480:'1500k',720:'2800k',1080:'5000k'}[variant.height]||'900k'),'-bufsize',({360:'1800k',480:'3000k',720:'5600k',1080:'10000k'}[variant.height]||'1800k'),'-threads','2','-pix_fmt','yuv420p','-force_key_frames','expr:gte(t,n_forced*4)','-c:a','aac','-b:a','128k','-ac','2');
    args.push('-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(directory,'part-%06d.m4s'),path.join(directory,'index.m3u8'));
    try{await run('ffmpeg',args,job);if(job.cancelled)return;variant.ready=true;}catch{if(job.cancelled)return;variant.failed=true;}
    variant.processing=false;notify();
   }
   job.status=job.variants.some(v=>v.ready)?'ready':'failed';if(job.status==='failed')job.error='Не удалось подготовить потоковое видео';notify();
   if(job.variants.some(v=>job.requests.has(v.id)&&!v.ready&&!v.failed)){const again=new Set(job.requests);jobs.delete(video.version);prepareStreams(video,onChange,null,again);}
  }catch{if(!job.cancelled){job.status='failed';job.error='Обработка видео недоступна. Используй оригинал.';notify();}}
 });
}
export async function streamAsset(video,quality,file){
 const job=jobs.get(video.version);const variant=job?.variants.find(v=>v.id===quality&&v.ready);
 if(!variant||!/^index\.m3u8$|^init\.mp4$|^part-\d{6}\.m4s$/.test(file))return null;
 const filePath=path.join(job.directory,quality,file);const info=await stat(filePath).catch(()=>null);return info?{path:filePath,size:info.size,playlist:file==='index.m3u8'}:null;
}
export function authenticatedPlaylist(text,token){const query='?token='+encodeURIComponent(token);return text.split('\n').map(line=>line.startsWith('#')?line.replace(/URI="([^"?]+)"/g,(_,uri)=>`URI="${uri}${query}"`):line.trim()?line+query:line).join('\n');}
export async function cancelStreams(video){const job=jobs.get(video.version);if(!job)return;job.cancelled=true;job.child?.kill('SIGTERM');jobs.delete(video.version);await rm(job.directory,{recursive:true,force:true});}
export async function waitForStreams(){await chain;}
