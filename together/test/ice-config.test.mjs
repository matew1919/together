import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getIceConfig,validateIceServers} from '../ice-config.mjs';
test('TURN требует корректного адреса и учётных данных',()=>{assert.throws(()=>validateIceServers([{urls:'https://example.com'}]));assert.throws(()=>validateIceServers([{urls:'turn:example.com:443'}]));assert.equal(validateIceServers([{urls:'turn:example.com:443',username:'u',credential:'p'}]).length,1);});
test('сервер читает TURN из локального файла, без него сообщает об отсутствии relay',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'together-ice-'));try{assert.equal((await getIceConfig(dir)).relayConfigured,false);await writeFile(path.join(dir,'turn.json'),JSON.stringify({iceServers:[{urls:'turn:example.com:443',username:'u',credential:'p'}]}));const config=await getIceConfig(dir);assert.equal(config.relayConfigured,true);assert.equal(config.iceServers[0].username,'u');}finally{await rm(dir,{recursive:true,force:true});}});
