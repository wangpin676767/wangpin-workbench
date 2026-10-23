'use strict';
const fs=require('node:fs').promises,path=require('node:path'),reader=require('./chatMetadataReader'),deletion=require('./chatDeletion');
const normal=p=>path.resolve(p).replace(/[\\/]+$/,'').toLowerCase();
const cwdKey=p=>typeof p==='string'?p.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase():'';
async function safePath(root,target,io,seen=new Set()){
 const relative=path.relative(root,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Inventory path escapes root');
 let current=path.parse(root).root,info;
 // Validate every ancestor, including parents of the supplied data root.
 for(const part of path.relative(current,target).split(path.sep).filter(Boolean)){
  current=path.join(current,part);if(current!==target&&seen.has(current))continue;const stat=info=await io.lstat(current);
  if(stat.isSymbolicLink()||normal(await io.realpath(current))!==normal(current))throw Error('Linked inventory paths rejected');
  if(current!==target)seen.add(current);
 }
 return info || io.lstat(target);
}
// Rows are re-read only when a file's size/time/inode signature changed, so the confirm-then-commit
// re-plan and later cleanups stat 700 files instead of re-parsing several GB of history.
const rowCache=new Map(),ROW_CACHE_LIMIT=20000;
const signature=stat=>[stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino].join(':');
// The row cache is also persisted (metadata only, no message bodies) so the first delete after launch skips re-parsing history.
// Entries stay valid only while the file signature matches, exactly like the in-memory cache.
const CACHE_FILE='chat-inventory-cache.json';const diskLoaded=new Set(),diskTimers=new Map();
function loadDisk(root){
 if(diskLoaded.has(root))return;diskLoaded.add(root);
 try{const file=path.join(root,CACHE_FILE),sync=require('node:fs');if(sync.statSync(file).size>4*1024*1024)return;const data=JSON.parse(sync.readFileSync(file,'utf8'));if(data?.version===1&&data.rows&&typeof data.rows==='object')for(const [key,value]of Object.entries(data.rows))if(value&&typeof value.sig==='string'&&value.row&&typeof value.row==='object'&&key===path.join(root,'chats',String(value.row.id)+'.json').toLowerCase())rowCache.set(key,value);}catch{/* no or unreadable cache: rebuild */}
}
function saveDisk(root){
 if(diskTimers.has(root))return;
 const timer=setTimeout(async()=>{diskTimers.delete(root);const file=path.join(root,CACHE_FILE),tmp=file+'.'+require('node:crypto').randomUUID()+'.tmp';
  const rows=Object.fromEntries([...rowCache].filter(([key])=>path.dirname(key)===path.join(root,'chats').toLowerCase()));
  const text=JSON.stringify({version:1,rows});if(Buffer.byteLength(text)>4*1024*1024)return;
  try{await fs.writeFile(tmp,text);await require('./atomicRename').replace(tmp,file);}catch{await fs.unlink(tmp).catch(()=>{});}
 },1500);timer.unref?.();diskTimers.set(root,timer);
}
async function inventory(dataRoot,{io=fs,signal,onProgress=()=>{},maxEntries=10000}={}){
 const root=path.resolve(dataRoot),directory=path.join(root,'chats'),out={rows:[],errors:[],files:0,bytes:0,stats:{}},useCache=io===fs,seen=new Set();
 await safePath(root,root,io,seen);
 if(useCache)loadDisk(root);let entries;
 try{await safePath(root,directory,io,seen);entries=await io.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return out;throw error;}
 const files=entries.filter(entry=>entry.name.endsWith('.json'));if(files.length>maxEntries)throw Error('Conversation inventory entry limit exceeded');
 for(let offset=0;offset<files.length;offset+=8){
 const stats=out.stats;
 const batch=await Promise.all(files.slice(offset,offset+8).map(async entry=>{
 const result={rows:[],errors:[],files:0,bytes:0,stats};
 const out=result;
  if(signal?.aborted)throw Error('Conversation inventory cancelled');
  const name=entry.name,id=name.slice(0,-5),filename=path.join(directory,name);
  try{
   deletion.validId(id);const before=await safePath(root,filename,io,seen);if(!before.isFile()||before.nlink>1)throw Error('Linked or invalid conversation file');
   const sig=signature(before),cacheKey=filename.toLowerCase(),hit=useCache?rowCache.get(cacheKey):null;
   if(hit&&hit.sig===sig&&hit.row.id===id){out.rows.push({...structuredClone(hit.row),size:before.size,mtimeMs:before.mtimeMs});out.files++;out.bytes+=before.size;out.stats.cachedRows=(out.stats.cachedRows||0)+1;return result;}
   const row=await reader.read(filename,io,out.stats,{deletion:true}),after=await safePath(root,filename,io,seen);
   if(!after.isFile()||[before.size,before.mtimeMs,before.ctimeMs,before.ino].some((value,index)=>value!==[after.size,after.mtimeMs,after.ctimeMs,after.ino][index]))throw Error('Conversation changed during inventory');
   if(row.id!==id)throw Error('Conversation filename and identity differ');
   if(row.messages!==undefined&&!Array.isArray(row.messages))throw Error('Invalid conversation messages');
   if(row.agent!=null&&(typeof row.agent!=='object'||Array.isArray(row.agent)||(row.agent.parentKey!=null&&typeof row.agent.parentKey!=='string')))throw Error('Invalid agent relationship metadata');
   if(row.agentFlowParentChatId!=null&&typeof row.agentFlowParentChatId!=='string')throw Error('Invalid flow relationship metadata');
   delete row.messages;
   if(useCache){if(rowCache.size>=ROW_CACHE_LIMIT)rowCache.clear();rowCache.set(cacheKey,{sig,row:structuredClone(row)});}
   if(useCache)saveDisk(root);
   out.rows.push({...row,size:before.size,mtimeMs:before.mtimeMs});out.files++;out.bytes+=before.size;
  }catch(error){out.errors.push({id,message:String(error.message || error)});}
  return result;
 }));
 for(const result of batch){out.rows.push(...result.rows);out.errors.push(...result.errors);out.files+=result.files;out.bytes+=result.bytes;}
 await onProgress({files:out.files,total:files.length,bytes:out.bytes,errors:out.errors.length});
 }
 return out;
}
function bulkPlan(rows,threads,settings={}, {activeIds=[]}={}){
 const byThread=new Map(threads.map(row=>[String(row.id).toLowerCase(),row])),owned=new Set(),edges=new Map();
 const appKey=id=>'app:'+id,nativeKey=id=>'codex:'+String(id).toLowerCase();
 function link(a,b){if(!a||!b)return;for(const [from,to]of[[a,b],[b,a]]){if(!edges.has(from))edges.set(from,new Set());edges.get(from).add(to);}}
 const idsOf=row=>[row.codexThreadId,row.codexActiveThreadId].filter(value=>typeof value==='string'&&value).map(value=>value.toLowerCase());
 const projects=new Set([...(settings.sidebarProjects || []),...(settings.sidebarSourceProjects?.codex || [])].map(cwdKey).filter(value=>value&&value!=='none'));
 for(const row of rows){
  for(const id of idsOf(row)){owned.add(id);link(appKey(row.id),nativeKey(id));}
  if(row.agent?.parentKey)link(appKey(row.id),row.agent.parentKey.startsWith('codex:')?nativeKey(row.agent.parentKey.slice(6)):row.agent.parentKey);
  if(row.agentFlowParentChatId)link(appKey(row.id),appKey(row.agentFlowParentChatId));
 }
 for(const key of settings.sidebarSourceConversations?.codex || [])if(typeof key==='string'&&key.startsWith('codex:'))owned.add(key.slice(6).toLowerCase());
 for(const thread of threads){const id=String(thread.id).toLowerCase();if(thread.cwd&&projects.has(cwdKey(thread.cwd)))owned.add(id);if(thread.parentThreadId)link(nativeKey(id),nativeKey(thread.parentThreadId));}
 // Native descendants inherit ownership from their explicitly loaded parent.
 let changed=true;while(changed){changed=false;for(const thread of threads)if(thread.parentThreadId&&owned.has(String(thread.parentThreadId).toLowerCase())&&!owned.has(String(thread.id).toLowerCase())){owned.add(String(thread.id).toLowerCase());changed=true;}}
 const active=new Set();for(const id of activeIds){const value=String(id);if(value.startsWith('app:')||value.startsWith('codex:'))active.add(value.startsWith('codex:')?nativeKey(value.slice(6)):value);else{active.add(appKey(value));active.add(nativeKey(value));}}
 const blocked=new Set(active),queue=[...active];for(let n=0;n<queue.length;n++)for(const child of edges.get(queue[n]) || [])if(!blocked.has(child)){blocked.add(child);queue.push(child);}
 const candidateApps=rows.filter(row=>row.agent||row.agentFlowStep||idsOf(row).some(id=>byThread.get(id)?.archived));
 const candidateThreads=threads.filter(row=>owned.has(String(row.id).toLowerCase())&&(row.archived||row.subagent));
 const selectedApp=candidateApps.filter(row=>!blocked.has(appKey(row.id))).map(row=>row.id),selectedNative=new Set(candidateThreads.filter(row=>!blocked.has(nativeKey(row.id))).map(row=>String(row.id).toLowerCase()));
 let appPlan;
 do{
  appPlan=deletion.createPlan(rows,{ids:selectedApp,threadIds:[...selectedNative]});changed=false;
  for(const id of appPlan.threadIds)if(!selectedNative.has(id)){selectedNative.add(id);changed=true;}
  for(const thread of threads)if(thread.parentThreadId&&selectedNative.has(String(thread.parentThreadId).toLowerCase())&&!selectedNative.has(String(thread.id).toLowerCase())){selectedNative.add(String(thread.id).toLowerCase());changed=true;}
 }while(changed);
 const skippedActive=[...new Set([...candidateApps.map(row=>appKey(row.id)),...candidateThreads.map(row=>nativeKey(row.id))].filter(key=>blocked.has(key)))];
 appPlan.keys=[...new Set([...appPlan.keys,...[...selectedNative].map(nativeKey)])];
 return {appPlan,ids:appPlan.ids,keys:appPlan.keys,threadIds:[...selectedNative],ownedThreadIds:[...owned],skippedActive,skippedActiveIds:skippedActive};
}
module.exports={inventory,bulkPlan};
