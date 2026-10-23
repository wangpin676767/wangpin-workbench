'use strict';
const {Worker,isMainThread,parentPort}=require('worker_threads');
if(!isMainThread){
 const cache=require('./codexIoCache').create();
 async function cachedRead(home){const source=require('./codexStateReader'),file=await source.findStateDb(home);if(!file)return null;return cache.read(file,[file,file+'-wal'],()=>source.readStateDb(home),value=>!value?.error);}
 let serial=Promise.resolve();
 parentPort.on('message',({id,home})=>{serial=serial.then(async()=>{try{parentPort.postMessage({id,value:await cachedRead(home)});}catch(error){parentPort.postMessage({id,error:String(error.message||error)});}});});
}
function create({idleMs=1000,deadlineMs=30000}={}){
 let worker=null,id=0,idle=null,failed=false;const waiting=new Map(),capacity=new Set();
 function wake(){for(const ready of capacity)ready();capacity.clear();}
 const counts={started:0,completed:0,fallbacks:0};
 function stop(error){clearTimeout(idle);const old=worker;worker=null;old?.terminate().catch(()=>{});for(const slot of waiting.values()){clearTimeout(slot.timer);slot.reject(error||Error('State worker stopped'));}waiting.clear();wake();}
 function get(){if(worker)return worker;const current=worker=new Worker(__filename);counts.started++;
  current.on('message',message=>{if(current!==worker)return;const slot=waiting.get(message.id);if(!slot)return;waiting.delete(message.id);wake();clearTimeout(slot.timer);counts.completed++;message.error?slot.reject(Error(message.error)):slot.resolve(message.value);if(!waiting.size){current.unref();idle=setTimeout(()=>stop(),idleMs);idle.unref();}});
  current.on('error',error=>{if(current===worker){failed=true;stop(error);}});
  current.on('exit',code=>{if(current===worker){failed=true;stop(Error('State worker exited '+code));}});return current;
 }
 async function read(home){
  while(!failed&&waiting.size>=8)await new Promise(resolve=>capacity.add(resolve));
  if(failed){counts.fallbacks++;return require('./codexStateReader').readStateDb(home);}
  try{return await new Promise((resolve,reject)=>{clearTimeout(idle);const current=get(),key=++id;current.ref();const timer=setTimeout(()=>{failed=true;stop(Error('State worker deadline'));},deadlineMs);waiting.set(key,{resolve,reject,timer});current.postMessage({id:key,home});});}
  catch{counts.fallbacks++;return require('./codexStateReader').readStateDb(home);}
 }
 return {read,close:()=>stop(),stats:()=>({...counts,active:waiting.size,backpressure:capacity.size,worker:!!worker,failed})};
}
module.exports={create};
