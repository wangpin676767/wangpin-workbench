'use strict';
const fs=require('node:fs/promises');
// One queue across all chat reads in the main process: 3,000,000 logical bytes/sec.
let queue=Promise.resolve();
async function readText(file,{bytesPerSecond=3000000,chunkSize=65536,clock=()=>performance.now(),delay=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 const work=queue.catch(()=>{}).then(async()=>{
  const handle=await fs.open(file,'r'),chunks=[];let scheduled=clock();
  try {for(;;){scheduled=Math.max(scheduled,clock())+chunkSize*1000/bytesPerSecond;await delay(Math.max(0,scheduled-clock()));const block=Buffer.allocUnsafe(chunkSize);const {bytesRead}=await handle.read(block,0,chunkSize,null);if(!bytesRead)break;chunks.push(block.subarray(0,bytesRead));}return Buffer.concat(chunks).toString('utf8');}
  finally{await handle.close();}
 });queue=work.catch(()=>{});return work;
}
module.exports={readText};
