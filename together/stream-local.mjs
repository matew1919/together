import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline/promises';
const data=process.env.DATA_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'.data');
let terminal,source,request,timer;
try {
 const {port,key}=JSON.parse(await readFile(path.join(data,'local-source-control.json'),'utf8'));
 request=async(route,body)=>{
  const res=await fetch('http://127.0.0.1:'+port+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const result=await res.json();if(!res.ok)throw Error(result.error);return result;
 };
 const {rooms}=await request('/rooms');if(!rooms.length)throw Error('Сначала создай комнату на сайте.');
 terminal=createInterface({input:process.stdin,output:process.stdout});
 const interrupt=async()=>{clearInterval(timer);if(source)await request('/stop',{id:source.id}).catch(()=>{});terminal.close();process.exit(130);};
 process.once('SIGINT',interrupt);terminal.once('SIGINT',interrupt);
 rooms.forEach((room,i)=>console.log(`${i+1}. ${room.id} — ${room.names.join(', ')}${room.video?' · '+room.video:''}`));
 const choice=rooms.length===1?'1':await terminal.question('Номер комнаты: ');
 const room=rooms[Number(choice)-1];if(!room)throw Error('Неверный номер комнаты');
 let file=(process.argv[2]||await terminal.question('Перетащи сюда скачиваемый файл или введи полный путь: ')).trim();
 file=file.replace(/^['"]|['"]$/g,'').replace(/\\([ ()])/g,'$1');if(file.startsWith('~/'))file=path.join(homedir(),file.slice(2));
 source=await request('/start',{room:room.id,file});
 console.log('\nПередаём: '+source.name+'\nПока файл скачивается, оставь это окно открытым.\nВедущий может нажать Play, когда накопятся первые фрагменты.');
 let last='';
 const poll=async()=>{
  const status=await request('/status?id='+encodeURIComponent(source.id));
  if(status.error)throw Error(status.error);
  const text=`Готово для плеера: ${Math.floor(status.duration||0)} сек. ${status.growing?'Ожидаем новые данные…':'Файл обработан целиком.'}`;
  if(text!==last){console.log(text);last=text;}return status;
 };
 timer=setInterval(()=>poll().catch(error=>{console.error(error.message);process.exitCode=1;terminal.close();clearInterval(timer);}),2000);
 await terminal.question('\nКогда скачивание закончится, нажми Enter здесь: ');
 clearInterval(timer);await request('/finish',{id:source.id});
 let status;do{status=await poll();if(status.growing)await new Promise(resolve=>setTimeout(resolve,1000));}while(status.growing);
 console.log('Готово. Видео остаётся доступным в этой комнате.');
 source=null;
} catch(error){
 console.error('\n'+(error.code==='ENOENT'?'Сначала запусти Together на этом компьютере.':error.message));process.exitCode=1;
} finally {clearInterval(timer);terminal?.close();if(source&&request)await request('/stop',{id:source.id}).catch(()=>{});}
