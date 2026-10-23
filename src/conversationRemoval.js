'use strict';
const fs=require('node:fs').promises,path=require('node:path');
const appDeletion=require('./chatDeletion'),appInventory=require('./chatDeletionInventory'),codex=require('./codexDeletion');
// Kept alive between requests so the DB signature cache survives; it terminates itself after 60s idle.
let shared;const sharedWorker=()=>shared||=require('./codexStateWorker').create({idleMs:60000});
async function prepare({dataRoot,codexHome,settings={},key,activeIds=[]}){
 const [local,state]=await Promise.all([appInventory.inventory(dataRoot),sharedWorker().read(codexHome)]);
 if(local.errors.length)throw Error('對話資料無法完整盤點，尚未刪除：'+local.errors.slice(0,3).map(e=>e.id+' '+e.message).join('；'));
 if(state?.error)throw Error('Codex 資料庫無法讀取，尚未刪除：'+state.error);
 const edges=new Map((state?.spawnEdges||[]).map(edge=>[String(edge.child).toLowerCase(),String(edge.parent).toLowerCase()]));
 const dbThreads=(state?.threads||[]).map(t=>({id:String(t.id).toLowerCase(),cwd:t.cwd,archived:!!t.archived,subagent:!!(t.agent_nickname||t.agent_path)||/sub.?agent/i.test(String(t.thread_source||'')+String(t.source||'')),parentThreadId:edges.get(String(t.id).toLowerCase()),rolloutPath:t.rollout_path||null}));
 // A single-conversation delete resolves everything from DB rows and exact rollout paths; only bulk cleanup walks the rollout tree.
 const native=key?{threads:dbThreads,errors:[]}:await codex.inventory(codexHome,dbThreads.map(({rolloutPath,...row})=>row));
 // An unreadable rollout prefix only loses rollout-derived parent/subagent hints; archive/subagent state still comes
 // from the DB rows and folder, so deletion stays conservative instead of aborting the whole inventory.
 const unverifiedRollouts=native.errors.length;
 let plan;
 if(!key){
  const recentlyWriting=native.threads.filter(t=>t.mtimeMs&&Date.now()-t.mtimeMs<30000).map(t=>'codex:'+t.id);
  plan=appInventory.bulkPlan(local.rows,native.threads,settings,{activeIds:[...activeIds,...recentlyWriting]});
 }
 else{
  if(!/^(app:[a-zA-Z0-9_-]+|codex:[0-9a-f-]{36})$/i.test(key))throw Error('無效的對話識別碼');
  if(key.startsWith('app:')&&!local.rows.some(r=>r.id===key.slice(4)) || key.startsWith('codex:')&&!native.threads.some(t=>t.id===key.slice(6).toLowerCase()))throw Error('找不到這段對話');
  let appPlan=appDeletion.createPlan(local.rows,{keys:[key]}),changed=true;
  while(changed){const tids=new Set(appPlan.threadIds);for(const row of native.threads)if(row.parentThreadId&&tids.has(row.parentThreadId))tids.add(row.id);const next=appDeletion.createPlan(local.rows,{ids:appPlan.ids,threadIds:[...tids],keys:[key]});changed=next.ids.length!==appPlan.ids.length||next.threadIds.length!==appPlan.threadIds.length;appPlan=next;}
  plan={appPlan,ids:appPlan.ids,threadIds:appPlan.threadIds,keys:[...new Set([...appPlan.keys,...appPlan.threadIds.map(id=>'codex:'+id)])],skippedActiveIds:[]};
 }
 const targetSet=new Set(plan.keys);
 if(activeIds.some(id=>targetSet.has(String(id))||plan.ids.includes(String(id).replace(/^app:/,''))))throw Error('這段對話或子代理正在執行，請先停止後再刪除');
 let target=null;
 if(key){
  const row=key.startsWith('app:')?local.rows.find(r=>r.id===key.slice(4)):(state?.threads||[]).find(t=>String(t.id).toLowerCase()===key.slice(6).toLowerCase());
  const titled=key.startsWith('app:')?require('./chatTitles').apply({...row},settings.sidebarTitleOverrides):{...row,title:settings.sidebarTitleOverrides?.[key]?.title || row?.title};
  target={key,title:titled?.title || '',cwd:row?.cwd || ''};
 }
 return {...plan,target,fast:!!key,dataRoot,codexHome,threads:native.threads,rows:local.rows,preview:{appChats:plan.ids.length,codexThreads:plan.threadIds.length,appBytes:local.rows.filter(r=>plan.ids.includes(r.id)).reduce((n,r)=>n+r.size,0),skippedActive:plan.skippedActiveIds?.length||0,unverifiedRollouts}};
}
async function execute(plan,{queueWrite,getActiveIds=()=>[],onDeleted=()=>{}}={}){
 const active=getActiveIds();if(active.some(id=>plan.keys.includes(String(id))||plan.ids.includes(String(id).replace(/^app:/,''))))throw Error('對話或子代理仍在執行，沒有刪除');
 // Native DB must accept the operation before deleting its mirrored App record.
 const exact=plan.fast&&plan.threadIds.every(id=>plan.threads.some(t=>t.id===id&&t.rolloutPath)),native=await codex.execute(plan.codexHome,plan.threads,plan.threadIds,{walk:!exact});
 if(native.errors.length)return {ok:false,deletedIds:[],deletedFiles:native.deletedFiles,deletedBytes:native.deletedBytes,errors:native.errors,partial:true};
 const local=await appDeletion.executePlan(plan.appPlan,{dataRoot:plan.dataRoot,queueWrite,getActiveIds,onDeleted});
 return {...local,deletedFiles:local.deletedFiles+native.deletedFiles,deletedBytes:local.deletedBytes+native.deletedBytes,codexThreads:native.threadCount,keys:plan.keys};
}
module.exports={prepare,execute};
