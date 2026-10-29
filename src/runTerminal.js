'use strict';
function guardCallbacks(handlers, failure, finished = () => false) {
  let ending = false;
  return Object.fromEntries(Object.entries(handlers).map(([name,fn])=>[name,(...args)=>{
    if (finished() || ending) return;
    if (name === 'onDone' || name === 'onError') ending = true;
    try { return Promise.resolve(fn(...args)).catch(error=>failure(error,name,args)); }
    catch(error) { return Promise.resolve(failure(error,name,args)); }
  }]));
}
function complete(task, resources, onError=()=>{}) {
  if (task.complete() === false) return;
  for (const release of resources) {
    try { Promise.resolve(release()).catch(onError); } catch(error) { onError(error); }
  }
}
module.exports={guardCallbacks,complete};
