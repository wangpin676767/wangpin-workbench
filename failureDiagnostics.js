'use strict';
const fs = require('fs'),path = require('path'),os = require('os');
const MAX_BYTES = 256 * 1024;
const clean = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64);
function create({directory,version,io=fs,metrics=()=>[]}={}) {
  function record(type,details={}) {
    try {
      const memory=process.memoryUsage();
      let list=[];try {list=metrics();} catch {}
      const event={at:new Date().toISOString(),type:clean(type),version:clean(version),reason:clean(details.reason),code:clean(details.code),exitCode:Number.isFinite(details.exitCode)?details.exitCode:null,
        memory:{rss:memory.rss,heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,external:memory.external,availableRAM:os.freemem(),totalRAM:os.totalmem()},
        processes:{count:list.length,workingSetKiB:list.reduce((n,item)=>n+(Number(item.memory?.workingSetSize)||0),0)}};
      const dir=directory(),file=path.join(dir,'crash-events.jsonl'),line=JSON.stringify(event)+'\n';
      io.mkdirSync(dir,{recursive:true});
      let size=0;try {size=io.statSync(file).size;} catch {}
      if (size+Buffer.byteLength(line)>MAX_BYTES) {
        try {io.unlinkSync(file+'.1');} catch(error) {if(error.code!=='ENOENT') throw error;}
        if (size>MAX_BYTES) io.truncateSync(file,MAX_BYTES);
        io.renameSync(file,file+'.1');
      }
      io.appendFileSync(file,line,'utf8');
      return true;
    } catch {return false;}
  }
  return {record};
}
module.exports={create,MAX_BYTES};
