'use strict';
const fs=require('fs').promises,v8=require('v8');
function create({io=fs,maxBytes=32*1024*1024,maxEntries=8}={}){
 const entries=new Map(),pending=new Map();let bytes=0;
 const counts={hits:0,misses:0,coalesced:0,sourceBytes:0,unstable:0};
 async function signature(files){return Promise.all(files.map(async file=>{try{const s=await io.stat(file);return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}catch(error){if(error.code==='ENOENT')return 'missing';throw error;}}));}
 async function read(key,files,load,accept=()=>true){
  // Signatures are checked before joining work, so a later version cannot join
  // an older outstanding read and accidentally install its stale cache row.
  const before=await signature(files),stamp=JSON.stringify(before),workKey=key+'\0'+stamp;
  const cached=entries.get(key);
  if(cached?.stamp===stamp){counts.hits++;entries.delete(key);entries.set(key,cached);return structuredClone(cached.value);}
  if(pending.has(workKey)){counts.coalesced++;return structuredClone(await pending.get(workKey));}
  const task=(async()=>{
   counts.misses++;counts.sourceBytes+=before.reduce((sum,s)=>sum+(Number(s.split(':')[0])||0),0);
   const value=await load(),after=await signature(files);
   if(JSON.stringify(after)!==stamp){counts.unstable++;return value;}
   if(accept(value)){
    const size=v8.serialize(value).length;
    if(size<=maxBytes){
     if(entries.has(key)){bytes-=entries.get(key).size;entries.delete(key);}
     while(entries.size&&(bytes+size>maxBytes||entries.size>=maxEntries)){const k=entries.keys().next().value;bytes-=entries.get(k).size;entries.delete(k);}
     entries.set(key,{stamp,value:structuredClone(value),size});bytes+=size;
    }
   }
   return value;
  })();
  pending.set(workKey,task);
  try{return structuredClone(await task);}finally{pending.delete(workKey);}
 }
 return {read,stats:()=>({...counts,bytes,entries:entries.size,pending:pending.size})};
}
module.exports={create};
