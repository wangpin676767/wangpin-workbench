'use strict';
// Search data is disposable: eviction only causes an exact reload, never truncation.
function create({maxBytes=32*1024*1024,maxEntries=128}={}){
 const rows=new Map();let bytes=0;
 function size(value){let n=256;for(const message of value.messages||[])n+=256+2*(String(message.text||'').length+String(message.ts||'').length+String(message.provider||'').length+String(message.source||'').length);return n;}
 return {
  get(key){const row=rows.get(key);if(!row)return;rows.delete(key);rows.set(key,row);return row.value;},
  set(key,value){if(rows.has(key)){bytes-=rows.get(key).bytes;rows.delete(key);}const n=size(value);if(n>maxBytes)return;while(rows.size&&(bytes+n>maxBytes||rows.size>=maxEntries)){const first=rows.keys().next().value;bytes-=rows.get(first).bytes;rows.delete(first);}rows.set(key,{value,bytes:n});bytes+=n;},
  clear(){rows.clear();bytes=0;},
  stats:()=>({entries:rows.size,bytes,maxBytes,maxEntries})
 };
}
module.exports={create};
