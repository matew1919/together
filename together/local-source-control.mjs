import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
export async function localSourceControl(data,handlers) {
  const key=randomBytes(24).toString('hex');const record=path.join(data,'local-source-control.json');
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.origin||req.headers.authorization!=='Bearer '+key)return json(403,{error:'Доступ только локальному помощнику сервера'});
    try {
      const url=new URL(req.url,'http://localhost');let input={};
      if(req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>8192)throw new Error('Слишком большой запрос');}input=JSON.parse(text||'{}');}
      if(req.method==='GET'&&url.pathname==='/rooms')return json(200,{rooms:handlers.rooms()});
      if(req.method==='POST'&&url.pathname==='/start')return json(200,await handlers.start(input));
      if(req.method==='GET'&&url.pathname==='/status')return json(200,handlers.status(url.searchParams.get('id')));
      if(req.method==='POST'&&url.pathname==='/finish')return json(200,handlers.finish(input.id));
      if(req.method==='POST'&&url.pathname==='/stop'){handlers.stop(input.id);return json(200,{ok:true});}
      json(404,{error:'Не найдено'});
    }catch(error){json(400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const value={port:server.address().port,key};await writeFile(record,JSON.stringify(value),{mode:0o600});
  return {close(){server.closeAllConnections();server.close();readFile(record,'utf8').then(text=>{if(JSON.parse(text).key===key)return unlink(record);}).catch(()=>{});}};
}
