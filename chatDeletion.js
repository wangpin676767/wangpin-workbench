'use strict';
// Operates on projected identities only; message bodies and shared attachments
// are deliberately outside this module's retained state and deletion scope.
const fs=require('node:fs').promises,path=require('node:path');
const ID=/^[a-zA-Z0-9_-]{1,200}$/;
function validId(id){if(typeof id!=='string'||!ID.test(id))throw Error('Invalid conversation identity');return id;}
function compact(row){return {id:validId(row.id),parentKey:row.agent?.parentKey || row.parentKey || null,
  agentFlowParentChatId:row.agentFlowParentChatId || row.agentFlowStep?.parentChatId || null,
  codexThreadId:row.codexThreadId || null,codexActiveThreadId:row.codexActiveThreadId || null};}
function nativeIds(row){return [row.codexThreadId,row.codexActiveThreadId].filter(x=>typeof x==='string'&&x).map(x=>x.toLowerCase());}
function createPlan(rows,{ids=[],keys=[],threadIds=[]}={}){
 const projected=rows.map(compact),wanted=new Set(ids.map(validId)),links=new Set(threadIds.map(x=>String(x).toLowerCase())),selectedKeys=new Set(keys);
 for(const key of keys){if(key.startsWith('app:'))wanted.add(validId(key.slice(4)));else if(key.startsWith('codex:'))links.add(key.slice(6).toLowerCase());}
 let changed=true;
 while(changed){changed=false;for(const row of projected){
  const natives=nativeIds(row),parent=row.parentKey;
  const hit=wanted.has(row.id)||natives.some(id=>links.has(id))||selectedKeys.has('app:'+row.id)
   ||(parent&&(selectedKeys.has(parent)||(parent.startsWith('app:')&&wanted.has(parent.slice(4)))||(parent.startsWith('codex:')&&links.has(parent.slice(6).toLowerCase()))))
   ||(row.agentFlowParentChatId&&wanted.has(row.agentFlowParentChatId));
  if(!hit)continue;
  if(!wanted.has(row.id)){wanted.add(row.id);changed=true;}
  selectedKeys.add('app:'+row.id);
  for(const id of natives)if(!links.has(id)){links.add(id);selectedKeys.add('codex:'+id);changed=true;}
 }}
 return {ids:[...wanted],keys:[...selectedKeys],threadIds:[...links],rows:projected.filter(row=>wanted.has(row.id))};
}
const norm=value=>path.resolve(value).replace(/[\\/]+$/,'').toLowerCase();
async function executePlan(plan,{dataRoot,queueWrite=(_id,work)=>work(),activeIds=[],getActiveIds=()=>activeIds,onDeleted=()=>{},io=fs,maxFiles=100000,maxDepth=64}={}){
 const root=path.resolve(dataRoot),ids=[...new Set(plan.ids.map(validId))],selected=new Set(ids);
 const report={ok:true,deletedIds:[],deletedFiles:0,deletedBytes:0,errors:[],preservedSharedAttachments:true};
 let reservedFiles=0;
 function assertIdle(){for(const value of getActiveIds() || []){const id=String(value).replace(/^app:/,'');if(selected.has(id)||plan.keys?.includes(value)||plan.threadIds?.includes(id.replace(/^codex:/,'')))throw Error('Conversation or descendant is still running');}}
 async function checked(target){
  const relative=path.relative(root,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Deletion target escapes data root');
  let current=root;
  for(const part of ['',...relative.split(path.sep).filter(Boolean)]){
   if(part)current=path.join(current,part);
   let info;try{info=await io.lstat(current);}catch(error){if(error.code==='ENOENT')return null;throw error;}
   if(info.isSymbolicLink()||norm(await io.realpath(current))!==norm(current))throw Error('Linked deletion path rejected');
   if(current!==target&&!info.isDirectory())throw Error('Invalid deletion parent');
   if(current===target)return info;
  }
  return null;
 }
 async function remove(target,depth=0){
  if(depth>maxDepth)throw Error('Conversation context nesting limit exceeded');
  assertIdle();const info=await checked(target);if(!info)return;
  if(info.isDirectory()){
   const names=await io.readdir(target);if(names.length>maxFiles)throw Error('Conversation context entry limit exceeded');
   for(const name of names)await remove(path.join(target,name),depth+1);
   assertIdle();await checked(target);await io.rmdir(target);
  }else if(info.isFile()){
   if(report.deletedFiles+reservedFiles>=maxFiles)throw Error('Conversation deletion file limit exceeded');
   if(info.nlink>1)throw Error('Multiply linked deletion file rejected');
   reservedFiles++;
   try{assertIdle();await checked(target);await io.unlink(target);report.deletedFiles++;report.deletedBytes+=info.size;}
   finally{reservedFiles--;}
  }else throw Error('Unsupported deletion file');
 }
 assertIdle();await checked(root);
 // Different conversation roots do not share owned context; overlap their independent
 // filesystem waits while keeping every path/active check and per-chat write barrier.
 for(let offset=0;offset<ids.length;offset+=4){
 await Promise.all(ids.slice(offset,offset+4).map(async id=>{
  try{await queueWrite(id,async()=>{
   assertIdle();const directory=path.join(root,'chats');await checked(directory);
   const exact=id+'.json',names=await io.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
   const targets=names.filter(name=>name===exact||name===exact+'.tmp'||(name.startsWith(exact+'.')&&/^[a-f0-9-]{6,64}\.tmp$/i.test(name.slice(exact.length+1))));
   for(const name of targets)await remove(path.join(directory,name));
   for(const folder of ['context-archives','extensions'])await remove(path.join(root,folder,id));
   await onDeleted(id);report.deletedIds.push(id);
  });}catch(error){report.errors.push({id,message:String(error.message || error)});}
 }));
 }
 const completed=new Set(report.deletedIds);report.deletedIds=ids.filter(id=>completed.has(id));
 report.ok=report.errors.length===0;return report;
}
module.exports={createPlan,executePlan,validId};
