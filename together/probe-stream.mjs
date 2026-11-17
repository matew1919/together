import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {values}=parseArgs({options:{
  local:{type:'string',default:'http://127.0.0.1:3000'},
  public:{type:'string'}, room:{type:'string'}, interface:{type:'string'}
}});
const data=process.env.DATA_DIR||fileURLToPath(new URL('.data/',import.meta.url));
const saved=JSON.parse(await readFile(path.join(data,'rooms.json'),'utf8'));
const room=saved.rooms.find(entry=>(!values.room||entry.id===values.room)&&entry.video&&entry.members.length);
if(!room)throw new Error('Открой комнату с видео и повтори замер.');
const route='/api/rooms/'+encodeURIComponent(room.id);
const member=room.members.find(item=>item.id===room.host)||room.members[0];
const local=new URL(values.local).origin;
const publicUrl=values.public||(await fetch(local+'/api/address',{signal:AbortSignal.timeout(5000)}).then(r=>r.json())).url;
const publicOrigin=publicUrl&&new URL(publicUrl).origin;
const peers=[{name:'Mac',origin:local}];
if(publicOrigin) {
  peers.push({name:'Публичный адрес',origin:publicOrigin});
  if(values.interface)peers.push({name:'Публичный адрес через '+values.interface,origin:publicOrigin,device:values.interface});
}
const format='%{http_code} %{size_download} %{time_starttransfer} %{time_total}';
function measure(peer,route,{auth=false,range}={}) {
  const args=['--silent','--max-time','15','--noproxy','*','--output','/dev/null','--write-out',format];
  if(peer.device)args.push('--interface',peer.device);
  if(range)args.push('--range',range);
  if(auth)args.push('--config','-');
  args.push(peer.origin+route);
  const result=spawnSync('curl',args,{encoding:'utf8',input:auth?'header = '+JSON.stringify('Authorization: Bearer '+member.token)+'\n':undefined});
  if(result.error)throw result.error;
  const [status,bytes,first,total]=result.stdout.trim().split(/\s+/).map(Number);
  return {status,bytes,first,total,error:result.status||0};
}
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const round=value=>Number(value.toFixed(2));
const rate=(bytes,seconds)=>seconds>0?round(bytes*8/1e6/seconds):null;

for(const origin of new Set(peers.map(peer=>peer.origin))) {
  const hostname=new URL(origin).hostname;
  const ping=spawnSync('ping',['-n','-c','4','-W','1000',hostname],{encoding:'utf8',timeout:9000});
  const summary=ping.stdout?.split('\n').filter(line=>line.includes('packet loss')||line.includes('min/avg/max')).join('\n');
  console.log(hostname+' ICMP\n'+(summary||'нет ответа'));
}

const headers={Authorization:'Bearer '+member.token};
const catalog=await fetch(local+route+'/media',{headers,signal:AbortSignal.timeout(5000)}).then(r=>r.json());
const qualities=(catalog.variants||[]).filter(item=>item.ready&&item.id!=='source');
const results=[];
for(const peer of peers) {
  const pings=Array.from({length:5},()=>measure(peer,'/api/time'));
  const times=pings.filter(item=>item.status===200&&!item.error).map(item=>item.total*1000);
  const original=measure(peer,route+'/video?v='+encodeURIComponent(room.video.version),{auth:true,range:'0-4194303'});
  const segments=qualities.map(quality=>{
    const prefix=route+'/hls/'+encodeURIComponent(room.video.version)+'/'+quality.id;
    const items=[0,1,2].map(index=>measure(peer,prefix+'/part-'+String(index).padStart(6,'0')+'.m4s',{auth:true}));
    const valid=items.filter(item=>item.status===200&&!item.error);
    return {quality:quality.height+'p',statuses:items.map(item=>item.status),complete:valid.length,
      seconds:round(valid.reduce((sum,item)=>sum+item.total,0)),
      mbps:rate(valid.reduce((sum,item)=>sum+item.bytes,0),valid.reduce((sum,item)=>sum+item.total,0))};
  });
  results.push({path:peer.name,httpPingOk:times.length,medianMs:times.length?round(median(times)):null,
    original:{status:original.status,bytes:original.bytes,ttfbMs:round(original.first*1000),seconds:round(original.total),
      mbps:rate(original.bytes,original.total),bodyMbps:rate(original.bytes,original.total-original.first),complete:original.status===206&&!original.error},
    segments});
}
console.log(JSON.stringify(results,null,2));
