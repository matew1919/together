import {createHash, randomBytes} from 'node:crypto';
import {createWriteStream, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {mkdir, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const videoTypes={webm:'video/webm',mkv:'video/x-matroska',mov:'video/quicktime',ogg:'video/ogg',ogv:'video/ogg'};
export function videoType(name) {
  const ext=path.extname(name).toLowerCase().slice(1);
  if(Object.hasOwn(videoTypes,ext))return videoTypes[ext];
  return ['mp4','m4v'].includes(ext)?'video/mp4':null;
}

export async function openVideoLibrary(data) {
  const directory=path.join(data,'videos'), index=path.join(data,'library.json');
  await mkdir(directory,{recursive:true});
  await Promise.all((await readdir(directory))
    .filter(file=>/^upload-[a-f0-9]+\.part$/.test(file))
    .map(file=>rm(path.join(directory,file),{force:true})));

  const assets=new Map();
  const assetPath=asset=>path.join(asset.legacy?data:directory,asset.file);
  try {
    for(const asset of JSON.parse(readFileSync(index,'utf8')).videos) {
      if(!/^[\w-]+\.video$/.test(asset.file)||!asset.names)continue;
      assets.set(asset.id,asset);
    }
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
  }

  function record(asset) {
    const videos=[...assets.values()].filter(other=>other.id!==asset.id);
    writeFileSync(index+'.tmp',JSON.stringify({videos:[...videos,asset]}),{mode:0o600});
    renameSync(index+'.tmp',index);
    assets.set(asset.id,asset);
  }
  function resolve(assetId,name) {
    const asset=assets.get(assetId);
    if(!asset)return null;
    const file=assetPath(asset);
    const info=statSync(file,{throwIfNoEntry:false});
    return info?.isFile()?{assetId:asset.id,name,path:file,size:info.size,type:asset.type}:null;
  }
  function visibleName(asset,viewer) {
    return asset.names[viewer.key]||(viewer.local?Object.values(asset.names)[0]:null);
  }
  function list(viewer) {
    const videos=[];
    for(const asset of assets.values()) {
      const name=visibleName(asset,viewer);
      if(name&&resolve(asset.id,name))videos.push({id:asset.id,name,size:asset.size,addedAt:asset.addedAt});
    }
    return videos.sort((a,b)=>b.addedAt-a.addedAt||a.name.localeCompare(b.name));
  }
  function select(assetId,viewer) {
    const asset=assets.get(assetId);
    const name=asset&&visibleName(asset,viewer);
    return name?resolve(assetId,name):null;
  }
  function restore(video) {
    if(video.assetId)return resolve(video.assetId,video.name);
    // Files saved by older versions already live in the data directory.
    const file=path.basename(video.path||'');
    if(!/^[\w-]+\.video$/.test(file)||path.resolve(video.path)!==path.join(data,file))return null;
    const info=statSync(video.path,{throwIfNoEntry:false});
    if(!info?.isFile())return null;
    const assetId='legacy-'+file.slice(0,-6);
    if(!assets.has(assetId))record({id:assetId,file,size:info.size,type:video.type,addedAt:info.mtimeMs,names:{local:video.name},legacy:true});
    return resolve(assetId,video.name);
  }
  async function save(input,{size,name,type,owner,checkOwner}) {
    const temporary=path.join(directory,'upload-'+randomBytes(12).toString('hex')+'.part');
    const hash=createHash('sha256');
    let bytes=0;
    try {
      await pipeline(input,new Transform({
        transform(chunk,encoding,done) {
          bytes+=chunk.length;
          if(bytes>size){done(new Error('Размер файла изменился'));return;}
          hash.update(chunk);
          done(null,chunk);
        }
      }),createWriteStream(temporary,{flags:'wx',mode:0o600}));
      if(bytes!==size)throw new Error('Файл загружен не полностью');
      checkOwner();

      const assetId=hash.digest('hex');
      const saved=assets.get(assetId);
      const asset={id:assetId,file:assetId+'.video',size,type,addedAt:Date.now(),...saved};
      const existing=statSync(assetPath(asset),{throwIfNoEntry:false});
      if(!existing?.isFile())renameSync(temporary,assetPath(asset));
      if(asset.names?.[owner]!==name)record({...asset,names:{...asset.names,[owner]:name}});
      return resolve(assetId,name);
    } finally {
      await rm(temporary,{force:true});
    }
  }
  return {list,select,restore,save};
}
