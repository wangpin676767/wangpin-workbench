'use strict';
// Large JSON parsing and legacy flow migration must not block Electron's main loop.
const {parentPort} = require('node:worker_threads');
const fs = require('node:fs/promises');
parentPort.on('message', async ({id,file,kind}) => {
  try {
    const value = JSON.parse(await fs.readFile(file,'utf8'));
    parentPort.postMessage({id,value});
  } catch (error) { parentPort.postMessage({id,error:{message:error.message,code:error.code,name:error.name}}); }
});
