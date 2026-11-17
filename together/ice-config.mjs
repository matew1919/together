import {readFile} from 'node:fs/promises';
import path from 'node:path';
const stun=[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478','stun:stun1.l.google.com:19302']}];
let cached=null;
export function validateIceServers(value){
  if(!Array.isArray(value)||!value.length||value.length>20)throw new Error('Некорректный список ICE-серверов');
  for(const server of value){
    const urls=Array.isArray(server.urls)?server.urls:[server.urls];
    if(!urls.length||urls.some(url=>typeof url!=='string'||!/^(stun|stuns|turn|turns):[^\s]+$/.test(url)))throw new Error('Некорректный адрес ICE-сервера');
    if(urls.some(url=>/^turns?:/.test(url))&&(typeof server.username!=='string'||typeof server.credential!=='string'))throw new Error('Для TURN нужны username и credential');
  }
  return value;
}
export async function getIceConfig(dataDir){
  let settings;
  try{settings=JSON.parse(await readFile(path.join(dataDir,'turn.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')console.warn('Не удалось прочитать настройки TURN');}
  try{
    if(process.env.ICE_SERVERS)return {iceServers:validateIceServers(JSON.parse(process.env.ICE_SERVERS)),relayConfigured:true};
    if(settings?.iceServers)return {iceServers:validateIceServers(settings.iceServers),relayConfigured:true};
    if(settings?.meteredDomain&&settings?.apiKey){
      const domain=String(settings.meteredDomain).toLowerCase();
      if(!/^[a-z0-9-]+\.metered\.live$/.test(domain))throw new Error('Некорректный домен Metered');
      const cacheKey=domain+':'+settings.apiKey;
      if(cached?.key===cacheKey&&cached.expires>Date.now())return {iceServers:cached.servers,relayConfigured:true};
      const url=new URL(`https://${domain}/api/v1/turn/credentials`);url.searchParams.set('apiKey',settings.apiKey);
      const response=await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok)throw new Error('Не удалось получить настройки TURN');
      const servers=validateIceServers(await response.json());
      cached={key:cacheKey,servers,expires:Date.now()+300000};
      return {iceServers:servers,relayConfigured:true};
    }
  }catch{console.warn('TURN недоступен: проверь настройки или ключ сервиса');return {iceServers:stun,relayConfigured:false,relayError:true};}
  return {iceServers:stun,relayConfigured:false};
}
