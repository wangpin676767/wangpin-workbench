'use strict';
// Serialize writes per key, retaining only the latest pending request.
function create(work) {
  const states = new Map();
  const counts = {started:0,completed:0,coalesced:0,maxPending:0};
  function request(key, data = {}) {
    let state = states.get(key);
    if (!state) {state={active:null,pending:null};states.set(key,state);}
    if (state.pending) {
      state.pending.data = {...data,terminal:state.pending.data.terminal || data.terminal};
      counts.coalesced++;
      return state.pending.promise;
    }
    let resolve,reject;
    const promise = new Promise((a,b)=>{resolve=a;reject=b;});
    state.pending={data,promise,resolve,reject};
    counts.maxPending=Math.max(counts.maxPending,1);
    if (!state.active) start(key,state);
    return promise;
  }
  function start(key,state) {
    const pending=state.pending;state.pending=null;state.active=pending;
    counts.started++;
    Promise.resolve().then(()=>work(key,pending.data)).then(pending.resolve,pending.reject).finally(()=>{
      counts.completed++;state.active=null;
      if (state.pending) start(key,state); else states.delete(key);
    });
  }
  return {request,stats:()=>({...counts,keys:states.size,active:[...states.values()].filter(s=>s.active).length,pending:[...states.values()].filter(s=>s.pending).length})};
}
module.exports={create};
