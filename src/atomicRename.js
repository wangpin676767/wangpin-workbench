'use strict';
const fsp=require('node:fs/promises');
const DEFAULT_DELAYS=[20,40,80,160,320,640,...Array(30).fill(1000)];
async function replace(from,to,{rename=fsp.rename,delay=ms=>new Promise(r=>setTimeout(r,ms)),delays=DEFAULT_DELAYS}={}) {
 for(let attempt=0;;attempt++) {
  try {await rename(from,to);return;}
  catch(error) {
   if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
   if(attempt>=delays.length){error.recoveryPath=from;error.message+='; prepared data preserved at '+from+' (destination not removed)';throw error;}
   await delay(delays[attempt]);
  }
 }
}
module.exports={replace,DEFAULT_DELAYS};
