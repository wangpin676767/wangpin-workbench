'use strict';
const fs=require('node:fs/promises');
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
function create({maxBytes=32*1024*1024,maxEntries=16,maxEntryBytes=8*1024*1024,inlineBytes=16*1024*1024,reader=require('./backgroundJson').create()}={}) {
  const entries=new Map(),pending=new Map();let bytes=0;
  function forget(file){const old=entries.get(file);if(old){bytes-=old.bytes;entries.delete(file);}}
  async function load(file) {
    for(let attempt=0;attempt<2;attempt++) {
      const before=await fs.stat(file),signature=stamp(before),hit=entries.get(file);
      if(hit?.signature===signature){entries.delete(file);entries.set(file,hit);return {value:hit.value,retained:true};}
      forget(file);
      // Worker startup/structured-clone costs exceed parsing costs on ordinary files.
      // Keep only large parsing off-main, with no artificial rate limit on either path.
      const text=before.size<=inlineBytes?await fs.readFile(file,'utf8'):null;
      const value=text!==null&&Buffer.byteLength(text)<=inlineBytes?JSON.parse(text):await reader.read(file);
      if(stamp(await fs.stat(file))!==signature)continue;
      // Account for UTF-16 text and per-message objects. Oversize conversations stay uncached.
      const cost=before.size*2+(Array.isArray(value?.messages)?value.messages.length*512:0);
      const retained=cost<=maxBytes&&before.size<=maxEntryBytes;
      if(retained){while(entries.size&&(bytes+cost>maxBytes||entries.size>=maxEntries))forget(entries.keys().next().value);entries.set(file,{signature,value,bytes:cost});bytes+=cost;}
      return {value,retained};
    }
    throw Error('Conversation changed while reading; please retry');
  }
  async function read(file) {
    let slot=pending.get(file);
    if(!slot){slot={work:load(file),readers:0};pending.set(file,slot);slot.work.finally(()=>{if(pending.get(file)===slot)pending.delete(file);}).catch(()=>{forget(file);});}
    slot.readers++;
    // Callers merge live fields and edit messages; never let them mutate retained originals.
    const {value,retained}=await slot.work;
    // A unique uncached result already belongs to this caller; copying it again is wasteful.
    return retained||slot.readers>1?structuredClone(value):value;
  }
  return {read,forget,close:()=>reader.close(),stats:()=>({entries:entries.size,bytes,pending:pending.size,maxBytes})};
}
module.exports={create};
