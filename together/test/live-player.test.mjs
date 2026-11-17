import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const functionText=source.slice(source.indexOf('async function useQuality('),source.indexOf('function applyCatalog('));
test('growing source never falls back to raw file while HLS is preparing',async()=>{
 const changes=[],c=vm.createContext({session:{},version:'v',room:{video:{live:true}},streamCatalog:{variants:[]},currentStream:null,window:{},hlsUnavailable:false,movie:{canPlayType:()=>''},changeSource:(...args)=>changes.push(args),originalVideoUrl:()=>{throw Error('raw source must not be used');}});
 vm.runInContext(functionText,c);await c.useQuality('auto',true);assert.deepEqual(changes,[]);
});
test('loading HLS library for growing source does not request original file',async()=>{
 let loaded=0;
 const c=vm.createContext({session:{},version:'v',room:{video:{live:true}},streamCatalog:{variants:[{id:'360',ready:true,height:360}]},currentStream:null,window:{MediaSource:true},hlsUnavailable:false,loadHls:()=>loaded++,changeSource:()=>{throw Error('must wait for HLS library');}});
 vm.runInContext(functionText,c);await c.useQuality('auto',true);assert.equal(loaded,1);
});
