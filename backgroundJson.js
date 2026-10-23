'use strict';
const {Worker} = require('node:worker_threads');
// One parse at a time; callers wait before dispatch rather than flooding the worker.
function create({idleMs=60000}={}) {
  let worker,slot,id=0,idle,tail=Promise.resolve(),closed=false;
  function stop(error=Error('JSON reader closed')) {
    clearTimeout(idle);const old=worker;worker=null;
    if(slot){const pending=slot;slot=null;pending.reject(error);}
    old?.terminate().catch(()=>{});
  }
  function get() {
    if(worker)return worker;
    const current=worker=new Worker(require.resolve('./jsonReadWorker'));
    current.on('message', result=>{
      if(current!==worker||result.id!==slot?.id)return;
      const pending=slot;slot=null;
      if(result.error)pending.reject(Object.assign(result.error.name==='SyntaxError'?new SyntaxError(result.error.message):Error(result.error.message),{code:result.error.code}));else pending.resolve(result.value);
      current.unref();idle=setTimeout(()=>stop(),idleMs);idle.unref();
    });
    current.on('error',error=>{if(current===worker)stop(error);});
    current.on('exit',code=>{if(current===worker)stop(Error('JSON reader exited '+code));});
    return current;
  }
  function read(file,kind='json') {
    if(closed)return Promise.reject(Error('JSON reader closed'));
    const work=tail.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
      if(closed){reject(Error('JSON reader closed'));return;}
      clearTimeout(idle);const current=get();current.ref();slot={id:++id,resolve,reject};current.postMessage({id,file,kind});
    }));tail=work;return work;
  }
  return {read,close:()=>{closed=true;stop();}};
}
module.exports={create};
