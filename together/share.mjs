import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {access} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import path from 'node:path';
import {createApp} from './server.mjs';

function openBrowser(url) {
  if(!process.argv.includes('--open'))return;
  const command=process.platform==='darwin'?'open':process.platform==='linux'?'xdg-open':null;
  if(!command)return;
  spawn(command,[url],{stdio:'ignore'}).on('error',()=>console.warn('Открой адрес в браузере вручную: '+url));
}
const data=path.resolve(process.env.DATA_DIR||fileURLToPath(new URL('.data',import.meta.url)));
const port=Number(process.env.PORT||3000);
const host='127.0.0.1';
const key='tunnel_ed25519';
let publicUrl=null,tunnel,retry,stopping=false;
const server=http.createServer();
const listening=once(server,'listening');
server.listen(port,host);
try {
  await listening;
} catch(error) {
  if(error.code!=='EADDRINUSE')throw error;
  const localUrl='http://'+host+':'+port;
  const existing=await fetch(localUrl+'/api/address',{signal:AbortSignal.timeout(2000)})
    .then(response=>response.ok?response.json():null).catch(()=>null);
  if(existing?.sharing===true) {
    console.log('Together уже запущен → '+localUrl+'\nДля обновления останови сервер в его окне через Ctrl+C и запусти снова.');
    openBrowser(localUrl);
    process.exitCode=0;
  } else {
    console.error('Порт '+port+' занят другим процессом. Освободи его или запусти Together с другим PORT.');
    process.exitCode=1;
  }
}



function connect() {
  const child=spawn('ssh',[
    '-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',
    '-o','UserKnownHostsFile=./ssh_known_hosts','-o','GlobalKnownHostsFile=none',
    '-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-i',key,
    '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10',
    '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
    '-R','80:'+host+':'+server.address().port,'stable@proxy.tunnl.gg','output=json'
  ],{cwd:data,stdio:['ignore','pipe','pipe']});
  tunnel=child;
  let candidate=null,healthTimer,failures=0,quotaLimited=false;
  const deadline=setTimeout(()=>child.kill(),25000);
  const lines=createInterface({input:child.stdout});
  async function check() {
    let status=null,healthy=false;
    try {
      const response=await fetch(candidate+'/api/time',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000)});
      status=response.status;
      healthy=response.ok&&Number.isFinite((await response.json()).now);
    }catch{}
    if(stopping||tunnel!==child)return;
    quotaLimited=status===429;
    if(healthy) {
      failures=0;
      if(publicUrl!==candidate) {
        publicUrl=candidate;
        server.emit('diagnostic','tunnel_connected',{address:candidate});
        console.log('Публичный адрес → '+candidate+'\nСкопируй приглашение из комнаты.');
      }
    } else {
      publicUrl=null;
      server.emit('diagnostic','tunnel_health_failed',{address:candidate,status});
      if(!quotaLimited&&++failures>=2){child.kill();return;}
    }
    healthTimer=setTimeout(check,quotaLimited?60000:healthy?15000:3000);
  }
  lines.on('line',line=>{
    let event;
    try{event=JSON.parse(line);}catch{return;}
    if(candidate||event?.event!=='tunnel'||typeof event.url!=='string'||!/^https:\/\/[a-z0-9-]+\.tunnl\.gg$/i.test(event.url))return;
    candidate=event.url;
    clearTimeout(deadline);
    check();
  });
  child.stderr.resume();
  child.on('error',error=>server.emit('diagnostic','tunnel_error',{code:error.code}));
  child.on('close',(code,signal)=>{
    lines.close();
    clearTimeout(deadline);
    clearTimeout(healthTimer);
    tunnel=null;
    server.emit('diagnostic','tunnel_closed',{address:candidate,code,signal,stopping});
    publicUrl=null;
    if(stopping)return;
    console.warn('HTTPS-ссылка недоступна. Переподключаю туннель.');
    retry=setTimeout(connect,quotaLimited?60000:10000);
  });
}

function stop() {
  stopping=true;
  clearTimeout(retry);
  tunnel?.kill();
  server.close();
  server.closeAllConnections();
}
async function start() {
  try {
    await createApp({server,publicOrigin:()=>publicUrl,sharing:true});

    try {
      await access(path.join(data,key));
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      await promisify(execFile)('ssh-keygen',['-q','-t','ed25519','-N','','-f',key],{cwd:data});
    }
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
    const localUrl='http://'+host+':'+server.address().port;
    console.log('На этом компьютере → '+localUrl);
    openBrowser(localUrl);
    console.log('Открываю публичную HTTPS-ссылку…');
    connect();
  } catch(error) {
    server.close();
    throw error;
  }
}

if(server.listening)await start();
